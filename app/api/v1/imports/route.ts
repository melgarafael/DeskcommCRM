import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { audit } from "@/lib/audit";
import { processCompaniesPeopleImport } from "@/lib/crm-b2b/import-process";
import { previaDaImportacao, totaisDaPrevia, type LinhaClassificada } from "@/lib/crm-b2b/import-previa";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";
import { definirCarteiraDoLote } from "@/lib/crm-b2b/import-carteira";
import { createAdminClient } from "@/lib/supabase/admin";
import { donoDaImportacaoSchema, importColumnMappingSchema } from "@/lib/crm-b2b/schemas";
import {
  IMPORT_MAX_BYTES,
  isCsvFilename,
  isXlsxFilename,
  parseImportFile,
  suggestColumnMapping,
  type MappingField,
} from "@/lib/crm-b2b/spreadsheet";
import {
  fail,
  handleRouteError,
  ok,
  requestIdOf,
  seModuloB2bDesligado,
} from "@/lib/crm-b2b/route-helpers";
import { lerCorpoComTeto } from "@/lib/api/corpo-com-teto";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/imports — lista lotes da org.
 * POST /api/v1/imports — upload CSV/XLSX + processa companies/people/contacts.
 *
 * Sessão OU token de servidor `dsk_…` (Spec 33, R3): `mcp:read` no GET (piso
 * viewer) e `mcp:write` no POST (piso agent, A23 parte 2). A organização vem da sessão ou
 * da LINHA do token, nunca do corpo. Pelo token não há pessoa: as colunas de
 * autor (`created_by`, `created_by_user_id`) ficam nulas e o audit grava o id do
 * token em `actor_api_token_id`.
 *
 * PRÉVIA (A23, #4888): com `previa=true` nada é gravado — a resposta traz os totais
 * por veredito e as linhas que ficariam de fora, com o motivo e de quem é o que já
 * existe. Sem `previa`, o servidor classifica DE NOVO (a base pode ter mudado desde
 * a prévia) e grava só as linhas `nova`; as demais ficam no lote com o motivo.
 *
 * DONO DA CARTEIRA (A23 parte 2): `dono_user_id` escolhe quem recebe os contatos
 * criados pelo lote (origem `importacao`); sem ele, quem importa. O Atendente só é
 * dono dele mesmo (403 `fora_da_posse` antes de gravar qualquer coisa); gerente e
 * admin escolhem qualquer membro ativo (422 `dono_invalido` se não for: convite pendente,
 * revogado ou de outra organização). `dono_user_id` passa pelo Zod (UUID; 422 se
 * não for). Por token não há pessoa: o ator da checagem NUNCA vem do `dono_user_id`
 * do corpo, e sem pessoa por trás a carteira não é definida (o lote grava, os contatos
 * ficam sem dono) — e, por isso, um `dono_user_id` enviado por token é validado como UUID e
 * depois IGNORADO: a resposta é `201` sem o bloco `carteira`, sem erro.
 *
 * O importador histórico de contatos (`/api/v1/contacts/import`) permanece.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = requestIdOf(req);
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "imports",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "imports", requestId);
  if (teto) return teto;

  try {
    const supabase = authz.supabase;
    const { data, error } = await supabase
      .from("import_batches")
      .select(
        "id, filename, status, kind, total_rows, processed_rows, successful_rows, failed_rows, conflict_rows, created_by, created_at, completed_at",
      )
      .eq("organization_id", authz.organizationId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) return fail("internal_error", error.message, 500, { requestId });
    return ok(data ?? [], { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = requestIdOf(req);
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "imports",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "imports", requestId);
  if (teto) return teto;
  // Só pessoa vira autor: o id de um token não existe em `auth.users`.
  const autorId = authz.actor.type === "user" ? authz.actor.id : null;

  // 64 KB de folga para o envelope multipart e o campo `mapping`.
  const corpo = await lerCorpoComTeto(req, IMPORT_MAX_BYTES + 64 * 1024, {
    requestId,
    idioma: authz.idioma,
    acimaDoTeto: "Arquivo grande demais.",
  });
  if (!corpo.ok) return corpo.response;

  try {
    const form = await corpo.corpo.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return fail("validation_failed", "Envie o arquivo no campo 'file'.", 422, { requestId });
    }
    const nome = file.name ?? "import.csv";
    if (!isCsvFilename(nome) && !isXlsxFilename(nome)) {
      return fail(
        "validation_failed",
        "Formato não suportado — envie .csv ou .xlsx.",
        422,
        { requestId },
      );
    }
    if (file.size > IMPORT_MAX_BYTES) {
      return fail("validation_failed", "Arquivo grande demais.", 422, { requestId });
    }

    let mapping: Partial<Record<MappingField, string>> = {};
    const mappingRaw = form.get("mapping");
    if (typeof mappingRaw === "string" && mappingRaw.trim()) {
      mapping = importColumnMappingSchema.parse(JSON.parse(mappingRaw));
    }

    const bytes = await file.arrayBuffer();
    const parsed = await parseImportFile(bytes, nome);
    if (!parsed.ok) {
      return fail("validation_failed", parsed.error, 422, { requestId });
    }

    if (Object.keys(mapping).length === 0) {
      mapping = suggestColumnMapping(parsed.sheet.headers);
    }

    const supabase = authz.supabase;

    // A23 parte 2: o dono da carteira. Decidido ANTES de gravar qualquer coisa — o
    // Atendente que pede outro dono recebe a recusa sem lote criado.
    const donoBruto = form.get("dono_user_id");
    let donoPedido: string | null = null;
    if (typeof donoBruto === "string" && donoBruto.trim()) {
      const dono = donoDaImportacaoSchema.safeParse(donoBruto);
      if (!dono.success) {
        return fail("validation_failed", "dono_user_id precisa ser um UUID.", 422, { requestId });
      }
      donoPedido = dono.data;
    }
    const donoId = donoPedido ?? autorId;
    if (autorId && donoPedido && donoPedido !== autorId && form.get("previa") !== "true") {
      // O papel vem de `authz.papelDaSessao` (`fn_user_role_in_org`, a MESMA função das
      // policies): nada de segunda consulta que falha aberta, e a regra é POSITIVA —
      // só gerente e admin escolhem outro dono; papel ausente ou outro cai em 403.
      const papel = authz.papelDaSessao;
      if (papel !== "manager" && papel !== "admin") {
        return fail(
          "fora_da_posse",
          "O atendente só pode ser dono dos contatos que ele mesmo importa.",
          403,
          { requestId },
        );
      }
      // O dono escolhido tem de ser membro ATIVO (convite aceito, não revogado, papel que
      // pode ter carteira): o mesmo predicado da função do banco. Sem isto o lote inteiro
      // gravava e cada contato era recusado depois, em silêncio. O cliente de serviço lê a
      // tabela porque a RLS só mostra ao atendente o próprio vínculo.
      const { data: membro, error: membroErr } = await createAdminClient()
        .from("user_organizations")
        .select("user_id")
        .eq("organization_id", authz.organizationId)
        .eq("user_id", donoPedido)
        .is("revoked_at", null)
        .not("accepted_at", "is", null)
        .in("role", ["agent", "manager", "admin"])
        .maybeSingle();
      if (membroErr) {
        return fail("internal_error", "Não foi possível conferir o dono escolhido.", 500, { requestId });
      }
      if (!membro) {
        return fail(
          "dono_invalido",
          "O dono escolhido não é um membro ativo desta organização.",
          422,
          { requestId },
        );
      }
    }

    // A23: a classificação vale para a prévia E para a gravação.
    const classificadas = await previaDaImportacao(supabase, {
      organizationId: authz.organizationId,
      sheet: parsed.sheet,
      mapping,
    });
    if (form.get("previa") === "true") {
      const donos = await nomesDosAtendentes(
        authz.organizationId,
        classificadas.map((l) => l.existente?.donoId),
      );
      return ok(
        {
          previa: totaisDaPrevia(classificadas),
          headers: parsed.sheet.headers,
          suggested_mapping: suggestColumnMapping(parsed.sheet.headers),
          linhas_fora: linhasDeFora(classificadas, parsed.sheet, donos),
        },
        { requestId },
      );
    }

    const { data: batch, error: batchErr } = await supabase
      .from("import_batches")
      .insert({
        organization_id: authz.organizationId,
        kind: "companies_people",
        filename: nome,
        status: "pending",
        total_rows: parsed.sheet.rows.length,
        column_mapping: mapping,
        created_by: autorId,
      })
      .select("id")
      .single();

    if (batchErr || !batch) {
      return fail("internal_error", batchErr?.message ?? "Falha ao criar lote.", 500, {
        requestId,
      });
    }

    const summary = await processCompaniesPeopleImport(supabase, {
      organizationId: authz.organizationId,
      batchId: batch.id,
      userId: autorId,
      sheet: parsed.sheet,
      mapping,
      enrichCompanies: form.get("enrich") !== "false",
      classificacao: new Map(classificadas.map((l) => [l.rowNumber, l])),
    });

    // A23 parte 2: os contatos que o lote criou entram na carteira do dono. Só com
    // PESSOA por trás (`autorId`): o ator é quem importa, nunca o dono pedido no corpo.
    // Por token (sem pessoa) o lote grava e a carteira não é definida.
    const carteira =
      autorId && donoId && summary.successful_rows > 0
        ? await definirCarteiraDoLote(createAdminClient(), {
            organizationId: authz.organizationId,
            batchId: batch.id,
            atorId: autorId,
            donoId,
          })
        : null;

    await audit({
      organizationId: authz.organizationId,
      actorUserId: autorId,
      actorApiTokenId: authz.apiTokenId ?? null,
      action: "imports.companies_people",
      resourceType: "import_batches",
      resourceId: batch.id,
      requestId,
      metadata: { ...summary, ...(carteira ? { carteira_dono: donoId, carteira } : {}) } as unknown as Record<string, unknown>,
    });

    return ok(
      {
        batch_id: batch.id,
        suggested_mapping: suggestColumnMapping(parsed.sheet.headers),
        headers: parsed.sheet.headers,
        ...(carteira ? { carteira: { dono_user_id: donoId, ...carteira } } : {}),
        ...summary,
      },
      { requestId, status: 201 },
    );
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}

/** O que o CSV de "ficaram de fora" precisa: a linha original, o veredito e de quem é o que já existe. */
function linhasDeFora(
  classificadas: readonly LinhaClassificada[],
  sheet: { headers: string[]; rows: string[][]; rowNumbers?: number[] },
  donos: ReadonlyMap<string, string | null>,
) {
  const porNumero = new Map(classificadas.map((l) => [l.rowNumber, l]));
  const fora: Array<{
    linha: number;
    status: string;
    motivo: string | null;
    existente_nome: string | null;
    de_quem: string | null;
    valores: string[];
  }> = [];
  sheet.rows.forEach((valores, i) => {
    const numero = sheet.rowNumbers?.[i] ?? i + 2;
    const v = porNumero.get(numero);
    if (!v || v.status === "nova" || v.status === "anexada") return;
    fora.push({
      linha: numero,
      status: v.status,
      motivo: v.motivo,
      existente_nome: v.existente?.nome ?? null,
      de_quem: v.existente?.donoId ? (donos.get(v.existente.donoId) ?? null) : null,
      valores,
    });
  });
  return fora;
}
