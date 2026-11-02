import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/lgpd/requests/[id]/art12
 *
 * O AVISO DE RECUSA OU PRORROGAÇÃO do art. 12.º do RGPD (n.os 3 e 4). A norma
 * manda informar o titular, com o MOTIVO, no prazo de um mês contado do
 * recebimento: sem motivo escrito não há aviso nenhum a mandar, e é a própria
 * rota que recusa (`MotivoObrigatorio`/422) em vez de entregar e-mail pela
 * metade.
 *
 * ─── A PORTA É FECHADA PARA ORGANIZAÇÃO BRASILEIRA ──────────────────────────
 *
 * O aviso vale só para organizações FORA do Brasil (decisão de produto de
 * 2026-10-16). Organização brasileira recebe a recusa ANTES de qualquer efeito
 * — nenhum e-mail, `due_at` intacto e nenhum `lgpd.art12_notice_sent` —, e a
 * recusa é o produto, não um erro. A guarda irmã, do aviso de apagamento, mora
 * no worker.
 *
 * O TERCEIRO aviso do art. 12.º — o de apagamento concluído — não passa por
 * aqui: ele sai sozinho do worker de anonimização, depois que a cascata
 * termina (`workers/lgpd-redact-worker.ts`, #2342). Esta rota é a boca do
 * operador, para os dois desfechos que ele decide.
 *
 * Body: `{ kind: "refusal" | "extension", reason: string }` — o `reason` é o
 * motivo que vai ESCRITO no e-mail. A prorrogação empurra `due_at` um mês para
 * frente (art. 12.º, n.º 5: até dois meses adicionais, informados com motivo);
 * a recusa não toca prazo nenhum.
 *
 * Idempotência pela PRÓPRIA LINHA: um segundo `POST` do mesmo desfecho devolve
 * 200 com `duplicate: true` e não manda o segundo e-mail. O marcador mora em
 * `request_payload.art12` (nenhuma tela o lê ainda).
 *
 * Auth: cookie session, role >= admin (ou platform admin).
 */
import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiErrorCodes } from "@/lib/api/errors";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  MotivoObrigatorio,
  dentroDoPrazoDeUmMes,
  montarAvisoArt12,
  prazoDeUmMes,
  sendAvisoArt12,
} from "@/lib/lgpd/avisos-do-artigo-12";
import { EmailNotConfigured } from "@/lib/lgpd/email-delivery";
import { diaDoPrazo } from "@/lib/lgpd/sla";
import { marcaDaSaida } from "@/lib/branding/saida";
import { perfilDaOrganizacao, PAIS_PADRAO } from "@/lib/legal/perfil-do-pais";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  kind: z.enum(["refusal", "extension"]),
  reason: z.string().trim().min(10).max(500),
});

/** Só pedido ABERTO recebe recusa/prorrogação: encerrado não tem o que prorrogar. */
const STATUS_ABERTO = new Set(["received", "processing", "pending_review"]);

interface PedidoLinha {
  id: string;
  organization_id: string;
  request_type: string;
  status: string;
  contact_id: string | null;
  received_at: string;
  due_at: string;
  request_payload: Record<string, unknown> | null;
}

interface MarcaArt12 {
  kind: "refusal" | "extension";
  reason: string;
  sent_at: string;
  prazo_de_um_mes: string;
  dentro_do_prazo: boolean;
  /** Todo desfecho já avisado neste pedido, e não só o último (ver a guarda abaixo). */
  avisados?: ("refusal" | "extension")[];
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  const authz = await requireRole("admin", {
    requestId,
    resource: "lgpd_requests",
    allowPlatformAdmin: true,
    permiteOrgSuspensa: true,
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const admin = createAdminClient();

  // ─── A PORTA FECHADA, ANTES DE TOCAR EM QUALQUER COISA ────────────────────
  //
  // O aviso do art. 12.º vale só para organizações FORA do Brasil (decisão de
  // produto de 2026-10-16): no Brasil nada muda por enquanto, porque a promessa
  // feita quando Portugal entrou foi "o Brasil fica exatamente igual", e texto
  // jurídico com o artigo errado chegando a titular real é pior que nenhum
  // texto. A recusa é o PRODUTO, não um erro — e ela vem ANTES de todo efeito:
  // nenhum e-mail, `due_at` intacto e nenhum `lgpd.art12_notice_sent` gravado.
  // Por isso o país é lido aqui, antes até do corpo da requisição; a guarda
  // irmã, do worker de apagamento, mora em `workers/lgpd-redact-worker.ts`.
  const perfil = await perfilDaOrganizacao(admin, orgId);
  if (perfil.codigo === PAIS_PADRAO) {
    return fail(
      ApiErrorCodes.lgpd_art12_so_fora_do_brasil,
      t("O aviso do art. 12.º vale só para organizações fora do Brasil."),
      422,
      { requestId },
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", t("Parâmetros inválidos."), 422, {
      details: parsed.error.flatten(),
      requestId,
    });
  }
  const { kind, reason } = parsed.data;

  const { id } = await params;
  const { data, error } = await admin
    .from("lgpd_requests")
    .select(
      "id, organization_id, request_type, status, contact_id, received_at, due_at, request_payload",
    )
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }
  const pedido = data as PedidoLinha | null;
  if (!pedido) {
    return fail("not_found", t("Solicitação não encontrada."), 404, { requestId });
  }

  if (!STATUS_ABERTO.has(pedido.status)) {
    return fail(
      "conflict",
      t("O pedido já foi encerrado — o aviso do art. 12.º só sai de pedido aberto."),
      409,
      { details: { status: pedido.status }, requestId },
    );
  }

  const payload = (pedido.request_payload ?? {}) as Record<string, unknown>;
  const anterior = (payload["art12"] ?? null) as MarcaArt12 | null;
  if (anterior && anterior.kind === kind) {
    // Mesmo desfecho já avisado: o titular não recebe o mesmo e-mail duas vezes.
    // (`...anterior` vem ANTES de `kind`: o tipo do marcador já o declara, e o
    // spread por último apagaria a propriedade — as duas declarações são o mesmo
    // valor, garantido pela comparação acima.)
    return ok(
      { request_id: pedido.id, ...anterior, kind, duplicate: true },
      { requestId },
    );
  }
  // Cada desfecho sai UMA vez por pedido, e não só "diferente do último":
  // alternar recusa e prorrogação não reenvia e-mail nem empurra o prazo de novo.
  const avisados = new Set(anterior ? [...(anterior.avisados ?? []), anterior.kind] : []);
  if (avisados.has(kind)) {
    return ok({ request_id: pedido.id, kind, duplicate: true }, { requestId });
  }

  // O endereço do titular: do contato, e do payload do pedido como fallback —
  // o webhook da plataforma entrega o e-mail mesmo quando o contato local não
  // tem nenhum. A mesma ordem do worker de apagamento.
  let emailTitular: string | null = null;
  if (pedido.contact_id) {
    const { data: contato } = await admin
      .from("contacts")
      .select("email")
      .eq("organization_id", orgId)
      .eq("id", pedido.contact_id)
      .maybeSingle();
    emailTitular = ((contato as { email?: string | null } | null)?.email ?? "").trim() || null;
  }
  const emailNoPayload = payload["email"];
  if (!emailTitular && typeof emailNoPayload === "string") {
    emailTitular = emailNoPayload.trim() || null;
  }
  if (!emailTitular) {
    return fail("titular_sem_email", t("O titular não tem e-mail para receber o aviso."), 422, {
      requestId,
    });
  }

  const recebidoEm = new Date(pedido.received_at);
  const agora = new Date();
  const prazo = prazoDeUmMes(recebidoEm);
  // O perfil já foi lido na guarda do país, no alto desta rota: UMA leitura só,
  // e é ela que decide o idioma e a lei do aviso.
  const marca = await marcaDaSaida(orgId, { semMemo: true });

  try {
    await sendAvisoArt12(
      {
        desfecho: kind === "refusal" ? "recusa" : "prorrogacao",
        requestId: pedido.id,
        marca,
        perfil,
        motivo: reason,
        novaData: prazoDeUmMes(agora),
        prazoDeUmMes: prazo,
        recebidoEm,
      },
      emailTitular,
    );
  } catch (err) {
    if (err instanceof MotivoObrigatorio) {
      return fail("motivo_obrigatorio", t("Parâmetros inválidos."), 422, { requestId });
    }
    if (err instanceof EmailNotConfigured) {
      return fail("email_not_configured", t("E-mail não configurado na instalação."), 503, {
        requestId,
      });
    }
    return fail("email_send_failed", t("Não foi possível enviar o aviso ao titular."), 502, {
      requestId,
    });
  }

  const marcaArt12: MarcaArt12 = {
    kind,
    reason,
    sent_at: agora.toISOString(),
    prazo_de_um_mes: prazo.toISOString(),
    dentro_do_prazo: dentroDoPrazoDeUmMes(recebidoEm, agora),
    avisados: [...avisados, kind],
  };

  // A prorrogação empurra o prazo de resposta (n.º 5): nunca para TRÁS do que a
  // linha já prometia — um vencimento mais distante não encurta prazo de ninguém.
  //
  // A comparação é entre DIAS CIVIS, pelo helper do dia, e não entre instantes: a
  // coluna `due_at` guarda o DIA que o motor contou (meia-noite UTC), e comparar
  // o instante de `prazoDeUmMes(agora)` com ele decidiria por horas do relógio —
  // o mesmo dia apareceria como dia diferente. O valor GRAVADO volta à meia-noite
  // UTC do dia novo, para a coluna seguir sendo um dia civil.
  const diaDoNovoPrazo = diaDoPrazo(prazoDeUmMes(agora));
  const diaDoPrazoAtual = diaDoPrazo(pedido.due_at);
  const empurraOPrazo =
    kind === "extension" &&
    diaDoNovoPrazo !== null &&
    (diaDoPrazoAtual === null || diaDoNovoPrazo > diaDoPrazoAtual);
  const novoPrazo = empurraOPrazo ? `${diaDoNovoPrazo}T00:00:00.000Z` : null;

  const { error: updErr } = await admin
    .from("lgpd_requests")
    .update({
      request_payload: { ...payload, art12: marcaArt12 },
      ...(novoPrazo ? { due_at: novoPrazo } : {}),
    })
    .eq("organization_id", orgId)
    .eq("id", pedido.id);

  if (updErr) {
    return fail("internal_error", updErr.message, 500, { requestId });
  }

  void audit({
    action: "lgpd.art12_notice_sent",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "lgpd_request",
    resourceId: pedido.id,
    requestId,
    metadata: {
      kind,
      dentro_do_prazo: marcaArt12.dentro_do_prazo,
      request_type: pedido.request_type,
      // O motivo NÃO entra cru no audit: o texto completo fica em
      // `request_payload.art12`. Aqui fica só a impressão digital, para
      // correlação.
      motivo_hash: createHash("sha256").update(reason).digest("hex").slice(0, 12),
      prorrogou_prazo: novoPrazo !== null,
    },
  });

  return ok(
    {
      request_id: pedido.id,
      ...marcaArt12,
      kind,
      duplicate: false,
      ...(novoPrazo ? { due_at: novoPrazo } : {}),
    },
    { requestId },
  );
}
