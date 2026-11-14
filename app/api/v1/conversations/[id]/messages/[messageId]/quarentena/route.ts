import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST/DELETE /api/v1/conversations/[id]/messages/[messageId]/quarentena
 *
 * A FATIA 1 DA #4026: o ESTADO da quarentena e o caminho explícito para entrar
 * e sair dela. Não há detecção aqui — quem decide que uma mensagem "parece
 * spam" é a fatia seguinte (classificação na entrada); esta rota é o marcador
 * manual que ela vai reusar e a revisão que o operador tem hoje.
 *
 * ─── O que a marca faz, e o que ela NÃO faz ─────────────────────────────────
 *
 * A linha da mensagem não muda: mesmo `id`, mesmo `body`, mesma mídia, mesma
 * posição na conversa. O que a marca segura é o EFEITO — o turno do agente
 * (`lib/agent-engine/edge/crm/drain.ts`), os handlers do `event_log` (automação,
 * push, campanha, follow-up: `lib/event-log/dispatcher.ts`) e os efeitos da
 * ingestão (`lib/channels/pos-entrada.ts`). Nenhum caminho desta fatia apaga,
 * esconde ou filtra mensagem em quarentena.
 *
 * ─── Liberar devolve ao fluxo, com duas travas ─────────────────────────────
 *
 * `DELETE` apaga a marca e chama `retomarFluxoDaMensagemLiberada`, que reusa
 * `aplicarEfeitosPosEntrada` — o mesmo caminho da ingestão, não uma segunda
 * régua. Se a mensagem já tinha resposta depois dela, só a marca sai: não há
 * reenvio retroativo (lado oposto (g) da issue).
 *
 * Auth: cookie session, agent+ (mesma régua do `pause-ai`: é uma decisão
 * operacional sobre uma conversa que a pessoa já vê). `requireSupportWrite()`
 * vem PRIMEIRO, antes do papel — em modo leitura a recusa é da guarda de
 * suporte, e o RBAC nem é consultado.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  liberarMensagemDaQuarentena,
  marcarMensagemEmQuarentena,
  MOTIVO_MAXIMO,
  MOTIVO_MINIMO,
  normalizarMotivo,
} from "@/lib/channels/quarentena";
import { retomarFluxoDaMensagemLiberada } from "@/lib/channels/retomada-da-quarentena";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string; messageId: string }>;
}

/**
 * A mensagem é DESTA conversa?
 *
 * O filtro por `conversation_id` não é redundância com o `id`: sem ele, uma
 * rota de mensagem aceitaria o id de uma mensagem de outra conversa da mesma
 * empresa e o caminho seria `/conversations/<qualquer>/messages/<alheia>`. A
 * organização vem do `requireRole` e é filtrada em toda escrita dos módulos.
 */
async function pertenceAConversa(
  supabase: SupabaseClient,
  organizationId: string,
  conversationId: string,
  messageId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("messages")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .eq("id", messageId)
    .maybeSingle();
  return !error && data != null;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: conversationId, messageId } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "messages" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  let corpo: { motivo?: unknown } = {};
  try {
    corpo = (await req.json()) as { motivo?: unknown };
  } catch {
    corpo = {};
  }
  const motivo = normalizarMotivo(typeof corpo.motivo === "string" ? corpo.motivo : null);
  if (!motivo) {
    return fail(
      "invalid_reason",
      `Diga por que esta mensagem está sendo segurada (${MOTIVO_MINIMO} a ${MOTIVO_MAXIMO} caracteres).`,
      422,
      { requestId },
    );
  }

  const supabase = await createClient();
  if (!(await pertenceAConversa(supabase, org.orgId, conversationId, messageId))) {
    return fail("not_found", "Mensagem não encontrada.", 404, { requestId });
  }

  const desfecho = await marcarMensagemEmQuarentena(supabase, {
    organizationId: org.orgId,
    messageId,
    motivo,
    porUserId: user.id,
  });
  if (!desfecho.ok) {
    if (desfecho.erro === "nao_encontrada") {
      return fail("not_found", "Mensagem não encontrada.", 404, { requestId });
    }
    if (desfecho.erro === "motivo_invalido") {
      return fail(
        "invalid_reason",
        `Diga por que esta mensagem está sendo segurada (${MOTIVO_MINIMO} a ${MOTIVO_MAXIMO} caracteres).`,
        422,
        { requestId },
      );
    }
    return fail("internal_error", "Não foi possível marcar a mensagem.", 500, { requestId });
  }

  // Idempotente: a segunda marca NÃO reescreve o motivo nem a hora da primeira,
  // e a auditoria registra a repetição como repetição (`ja_estava`).
  await audit({
    action: "message.quarantined",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "message",
    resourceId: messageId,
    requestId,
    metadata: { motivo, ja_estava: desfecho.jaEstava, conversation_id: conversationId },
  });

  return ok(
    {
      em_quarentena: true,
      ja_estava: desfecho.jaEstava,
      marcada_em: desfecho.em,
      motivo,
    },
    { requestId },
  );
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: conversationId, messageId } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "messages" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const supabase = await createClient();
  if (!(await pertenceAConversa(supabase, org.orgId, conversationId, messageId))) {
    return fail("not_found", "Mensagem não encontrada.", 404, { requestId });
  }

  const desfecho = await liberarMensagemDaQuarentena(supabase, {
    organizationId: org.orgId,
    messageId,
  });
  if (!desfecho.ok) {
    if (desfecho.erro === "nao_encontrada") {
      return fail("not_found", "Mensagem não encontrada.", 404, { requestId });
    }
    return fail("internal_error", "Não foi possível liberar a mensagem.", 500, { requestId });
  }

  // Só há fluxo a retomar se havia o que liberar. Liberar duas vezes é no-op.
  const retomada = desfecho.estava
    ? await retomarFluxoDaMensagemLiberada(createAdminClient() as unknown as SupabaseClient, {
        organizationId: org.orgId,
        messageId,
      })
    : ({ retomou: false, motivo: "nao_estava" } as const);

  await audit({
    action: "message.quarantine_released",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "message",
    resourceId: messageId,
    requestId,
    metadata: {
      estava_em_quarentena: desfecho.estava,
      motivo_anterior: desfecho.motivo,
      retomou: retomada.retomou,
      retomada: retomada.retomou ? null : retomada.motivo,
      conversation_id: conversationId,
    },
  });

  return ok(
    {
      em_quarentena: false,
      estava_em_quarentena: desfecho.estava,
      retomou: retomada.retomou,
      retomada: retomada.retomou ? null : retomada.motivo,
    },
    { requestId },
  );
}
