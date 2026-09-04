/**
 * POST /api/v1/contacts/import — importa contatos de planilha CSV.
 *
 * Formato aceito: CSV RFC 4180 com linha de cabeçalho (delimitador detectado
 * automaticamente entre vírgula, ponto-e-vírgula e tabulação — Excel pt-BR
 * exporta ";"). Colunas reconhecidas e apelidos em `lib/contacts/csv.ts`.
 * XLSX é recusado na borda com instrução de exportar como CSV.
 *
 * Desfecho POR LINHA, nunca do lote inteiro:
 *   - linha inválida é pulada com motivo nominal (vem no response);
 *   - contato que já existe (telefone/e-mail/CPF da org) é contado como
 *     duplicado, não como erro;
 *   - as demais linhas seguem mesmo se uma falhar — uma planilha de 400 nomes
 *     não pode morrer inteira pelo telefone malformado da linha 7.
 *
 * Insert é linha a linha de propósito: `contacts` tem índices únicos parciais
 * (org+phone/org+email/org+cpf) e um insert em lote viraria tudo-ou-nada —
 * o 23505 de UM conflito descartaria as outras centenas criadas.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { encryptCpfSql, hashCpf } from "@/lib/contacts/cpf";
import {
  CSV_MAX_BYTES,
  CSV_MAX_DATA_ROWS,
  decodificarCsv,
  mapHeader,
  mapLinha,
  parseCsv,
} from "@/lib/contacts/csv";
import { contactCreateSchema, isValidCpf } from "@/lib/schemas";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const SOURCE_IMPORT_CSV = "import_csv";

interface LinhaErro {
  linha: number;
  motivo: string;
}

interface ImportSummary {
  total_linhas: number;
  imported: number;
  skipped_duplicates: number;
  errors: LinhaErro[];
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();
  // spec 13 §4: escrita é agent+ (viewer é read-only), igual ao POST unitário.
  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const user = authz.user;
  const orgId = authz.org.orgId;

  let file: File;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (!(f instanceof File)) throw new Error("sem arquivo");
    file = f;
  } catch {
    return fail("validation_failed", "Envie o arquivo como multipart/form-data no campo 'file'.", 422, {
      requestId,
    });
  }

  const nome = file.name ?? "";
  const tipoOk =
    nome.toLowerCase().endsWith(".csv") ||
    file.type === "text/csv" ||
    file.type === "application/vnd.ms-excel";
  if (!tipoOk) {
    return fail(
      "validation_failed",
      "Formato não suportado — envie um arquivo .csv. No Excel use 'Salvar como' → 'CSV UTF-8'.",
      422,
      { requestId },
    );
  }
  if (file.size > CSV_MAX_BYTES) {
    return fail("validation_failed", `Arquivo maior que ${Math.floor(CSV_MAX_BYTES / 1024 / 1024)}MB.`, 413, {
      requestId,
    });
  }

  // ─── Parse + validação de linhas (puro; nada tocou no banco ainda) ───────
  // Os BYTES, não `file.text()` — ver `decodificarCsv` (#483).
  const decodificado = decodificarCsv(await file.arrayBuffer());
  if ("erro" in decodificado) {
    return fail("validation_failed", decodificado.erro, 422, { requestId });
  }
  const text = decodificado.texto;
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return fail("validation_failed", "CSV vazio ou sem linhas de dados.", 422, { requestId });
  }
  const header = rows[0]!;
  const mapeado = mapHeader(header);
  if (mapeado.motivo !== null) {
    return fail("validation_failed", `Cabeçalho inválido: ${mapeado.motivo}.`, 422, {
      details: { header: header.join(", ") },
      requestId,
    });
  }
  const indices = mapeado.indices;

  const dataRows = rows.slice(1);
  if (dataRows.length > CSV_MAX_DATA_ROWS) {
    return fail(
      "validation_failed",
      `Máximo de ${CSV_MAX_DATA_ROWS} linhas por importação — divida a planilha.`,
      422,
      { requestId },
    );
  }

  const candidatos: Array<{ linha: number; contato: Record<string, unknown> }> = [];
  const errors: LinhaErro[] = [];
  const vistosNoArquivo = new Set<string>();

  for (let i = 0; i < dataRows.length; i++) {
    const linha = i + 2; // 1-based contando o cabeçalho — bate com o editor de planilhas.
    const { contato, motivo } = mapLinha(dataRows[i]!, indices);
    if (motivo !== null) {
      errors.push({ linha, motivo });
      continue;
    }
    if (contato.cpf && !isValidCpf(contato.cpf)) {
      errors.push({ linha, motivo: `CPF inválido: "${contato.cpf}"` });
      continue;
    }
    const chave = contato.phone_number ?? `email:${(contato.email as string).toLowerCase()}`;
    if (vistosNoArquivo.has(chave)) {
      continue; // repetido DENTRO do arquivo — conta como duplicado, sem ruído de erro.
    }
    vistosNoArquivo.add(chave);

    const parsed = contactCreateSchema.safeParse({ ...contato, source: SOURCE_IMPORT_CSV });
    if (!parsed.success) {
      const primeiro = parsed.error.issues[0];
      errors.push({ linha, motivo: primeiro?.message ?? "dados inválidos" });
      continue;
    }
    candidatos.push({ linha, contato: parsed.data as Record<string, unknown> });
  }

  if (candidatos.length === 0) {
    const resumo: ImportSummary = {
      total_linhas: dataRows.length,
      imported: 0,
      skipped_duplicates: 0,
      errors,
    };
    return ok(resumo, { requestId });
  }

  // ─── Pré-filtro de duplicados contra o banco (uma query por identificador) ──
  //
  // Os índices únicos são parciais (excluem mesclados/anonimizados), então a
  // busca espelha o WHERE do índice — filtrar pelo que o índice não cobre
  // produziria "duplicado" imaginário.
  const phones = candidatos
    .map((c) => c.contato.phone_number as string | undefined)
    .filter((p): p is string => typeof p === "string");
  const emails = candidatos
    .map((c) => c.contato.email as string | undefined)
    .filter((e): e is string => typeof e === "string");

  const existentes = new Set<string>();
  if (phones.length > 0) {
    const lookup = [...new Set(phones.flatMap((p) => phoneLookupVariants(p)))];
    const { data } = await supabase
      .from("contacts")
      .select("phone_number")
      .eq("organization_id", orgId)
      .not("phone_number", "is", null)
      .in("phone_number", lookup);
    for (const r of data ?? []) {
      for (const v of phoneLookupVariants((r as { phone_number: string }).phone_number)) {
        existentes.add(`tel:${v}`);
      }
    }
  }
  if (emails.length > 0) {
    const { data } = await supabase
      .from("contacts")
      .select("email_normalized")
      .eq("organization_id", orgId)
      .in("email_normalized", emails.map((e) => e.toLowerCase()));
    for (const r of data ?? []) existentes.add(`email:${(r as { email_normalized: string }).email_normalized}`);
  }

  // ─── Insert linha a linha com desfecho individual ─────────────────────────
  let imported = 0;
  let skippedDuplicates = 0;

  for (const { linha, contato } of candidatos) {
    const phone = contato.phone_number as string | undefined;
    const email = contato.email as string | undefined;
    if (
      (phone && phoneLookupVariants(phone).some((v) => existentes.has(`tel:${v}`))) ||
      (email && existentes.has(`email:${email.toLowerCase()}`))
    ) {
      skippedDuplicates += 1;
      continue;
    }

    const insertRow: Record<string, unknown> = {
      organization_id: orgId,
      created_by_user_id: user.id,
      name: contato.name ?? null,
      display_name: contato.display_name ?? null,
      email: contato.email ?? null,
      phone_number: contato.phone_number ?? null,
      birthdate: contato.birthdate ?? null,
      tags: contato.tags ?? [],
      source: SOURCE_IMPORT_CSV,
      source_metadata: {},
      consent: {},
    };
    if (contato.cpf) {
      insertRow.cpf_hash = hashCpf(contato.cpf as string);
      // LGPD: além do hash (dedupe), grava a versão cifrada — igual ao create
      // unitário, senão o contato importado nasce sem CPF recuperável.
      const enc = await encryptCpfSql(supabase, contato.cpf as string);
      if (enc) insertRow.cpf_encrypted = enc;
    }

    const { data: criado, error: insErr } = await supabase
      .from("contacts")
      .insert(insertRow)
      .select("id, display_name, phone_number")
      .single();

    if (insErr) {
      // Conflito de corrida com os índices únicos = duplicado, não erro.
      if (insErr.code === "23505") {
        skippedDuplicates += 1;
        continue;
      }
      errors.push({ linha, motivo: insErr.message });
      continue;
    }

    imported += 1;
    if (phone) existentes.add(`tel:${phone}`);
    if (email) existentes.add(`email:${email.toLowerCase()}`);

    // Mesmo evento do create unitário — quem consome `contact.created`
    // (workers, métricas) trata importado e manual igual.
    await supabase
      .rpc("emit_event", {
        p_event_type: "contact.created",
        p_entity_kind: "contact",
        p_entity_id: (criado as { id: string }).id,
        p_payload: {
          source: SOURCE_IMPORT_CSV,
          has_email: !!contato.email,
          has_phone: !!contato.phone_number,
          has_cpf: !!contato.cpf,
        },
        p_metadata: { request_id: requestId, actor_type: "user" },
        p_organization_id: orgId,
      })
      .then(({ error }) => {
        if (error) console.error("[contacts.import] emit_event failed", error.message);
      });
  }

  await audit({
    action: "contacts.imported",
    actorUserId: user.id,
    organizationId: orgId,
    resourceType: "contact",
    resourceId: null,
    requestId,
    metadata: {
      actor_type: "user",
      total_linhas: dataRows.length,
      imported,
      skipped_duplicates: skippedDuplicates,
      erros: errors.length,
    },
  });

  const resumo: ImportSummary = {
    total_linhas: dataRows.length,
    imported,
    skipped_duplicates: skippedDuplicates,
    errors,
  };
  return ok(resumo, { requestId });
}
