import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/lgpd/requests/[id]/art12
 *
 * O AVISO DE RECUSA OU PRORROGAÇÃO do art. 12.º do RGPD (n.os 3 e 4) — e o
 * mesmo dever em palavras brasileiras (LGPD art. 19, §§1 e 2). A norma manda
 * informar o titular, com o MOTIVO, no prazo de um mês contado do recebimento:
 * sem motivo escrito não há aviso nenhum a mandar, e é a própria rota que
 * recusa (`MotivoObrigatorio`/422) em vez de entregar e-mail pela metade.
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
 * `request_payload.art12`, que a tela de detalhe já mostra.
 *
 * Auth: cookie session, role >= admin (ou platform admin).
 */
import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
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
import { marcaDaSaida } from "@/lib/branding/saida";
import { perfilDaOrganizacao } from "@/lib/legal/perfil-do-pais";
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

  // O endereço do titular: do contato, e do payload do pedido como fallback —
  // o webhook da plataforma entrega o e-mail mesmo quando o contato local não
  // tem nenhum.
  const emailNoPayload = payload["email"];
  let emailTitular: string | null =
    typeof emailNoPayload === "string" ? emailNoPayload.trim() : null;
  if (!emailTitular && pedido.contact_id) {
    const { data: contato } = await admin
      .from("contacts")
      .select("email")
      .eq("organization_id", orgId)
      .eq("id", pedido.contact_id)
      .maybeSingle();
    emailTitular = ((contato as { email?: string | null } | null)?.email ?? "").trim() || null;
  }
  if (!emailTitular) {
    return fail("titular_sem_email", t("O titular não tem e-mail para receber o aviso."), 422, {
      requestId,
    });
  }

  const recebidoEm = new Date(pedido.received_at);
  const agora = new Date();
  const prazo = prazoDeUmMes(recebidoEm);
  const [perfil, marca] = await Promise.all([
    perfilDaOrganizacao(admin, orgId),
    marcaDaSaida(orgId),
  ]);

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
  };

  // A prorrogação empurra o prazo de resposta (n.º 5): nunca para TRÁS do que a
  // linha já prometia — um vencimento mais distante não encurta prazo de ninguém.
  const novoPrazo =
    kind === "extension" && prazoDeUmMes(agora).getTime() > new Date(pedido.due_at).getTime()
      ? prazoDeUmMes(agora).toISOString()
      : null;

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
      // O motivo NÃO entra cru no audit: o texto completo está em
      // `request_payload.art12`, que a tela de detalhe já mostra a quem tem
      // direito. Aqui fica só a impressão digital, para correlação.
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
