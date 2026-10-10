import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { roleAtLeast } from "@/lib/auth/types";
import { canalAceitaTextoLivreAgora } from "@/lib/channels/janela";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Agendada = {
  id: string;
  organization_id: string;
  conversation_id: string;
  created_by_user_id: string | null;
  body: string;
};

type Final = "dispatched" | "failed";
const motivosConhecidos = new Set([
  "atendente_removido",
  "atendente_sem_acesso",
  "conversa_encerrada",
  "janela_fechada",
]);

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req))
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  const db = createAdminClient();
  const agora = new Date().toISOString();
  // Uma batida interrompida não reenvia às cegas. A identidade da mensagem é
  // o próprio id do agendamento, então conseguimos mostrar o resultado conhecido
  // e sinalizar o restante como incerto para revisão humana.
  const { data: interrompidas } = await db
    .from("scheduled_messages")
    .select("id, organization_id, conversation_id, created_by_user_id")
    .eq("status", "sending")
    .lt("claimed_at", new Date(Date.now() - 10 * 60_000).toISOString())
    .limit(20);
  for (const item of interrompidas ?? []) {
    const { data: mensagem } = await db
      .from("messages")
      .select("id, status")
      .eq("organization_id", item.organization_id)
      .eq("id", item.id)
      .maybeSingle();
    const entregouAoCanal = mensagem && ["sent", "delivered", "read"].includes(mensagem.status);
    const { data: resolvida, error: resolveError } = await db
      .from("scheduled_messages")
      .update({
        status: entregouAoCanal ? "dispatched" : "failed",
        message_id: mensagem?.id ?? null,
        error_code: entregouAoCanal ? null : "resultado_incerto",
        finished_at: agora,
        updated_at: agora,
      })
      .eq("id", item.id)
      .eq("organization_id", item.organization_id)
      .eq("status", "sending")
      .select("id")
      .maybeSingle();
    if (resolveError) {
      logger.error("[scheduled-messages] reconciliação não foi gravada", {
        scheduledMessageId: item.id,
        requestId,
        detail: resolveError.message,
      });
    } else if (resolvida) {
      void audit({
        action: entregouAoCanal ? "message.schedule_dispatched" : "message.schedule_failed",
        actorUserId: item.created_by_user_id,
        organizationId: item.organization_id,
        resourceType: "scheduled_message",
        resourceId: item.id,
        requestId,
        metadata: {
          conversation_id: item.conversation_id,
          message_id: mensagem?.id ?? null,
          error_code: entregouAoCanal ? null : "resultado_incerto",
        },
      });
    }
  }
  const { data: pendentes, error } = await db
    .from("scheduled_messages")
    .select("id, organization_id, conversation_id, created_by_user_id, body")
    .eq("status", "pending")
    .lte("scheduled_at", agora)
    .order("scheduled_at", { ascending: true })
    .limit(20);
  if (error)
    return fail("internal_error", "Não foi possível ler agendamentos.", 500, { requestId });

  let despachadas = 0;
  let falhas = 0;
  for (const candidata of (pendentes ?? []) as Agendada[]) {
    // A atualização condicional é o claim: duas rodadas concorrentes jamais
    // fazem a mesma tentativa. "sending" não é retomado automaticamente;
    // uma falha depois do envio pode ter resultado incerto, e repetir arrisca
    // mandar a mensagem duas vezes ao cliente.
    const { data: job, error: claimError } = await db
      .from("scheduled_messages")
      .update({
        status: "sending",
        claimed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", candidata.id)
      .eq("organization_id", candidata.organization_id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (claimError || !job) continue;

    let final: Final = "failed";
    let code: string | null = null;
    let messageId: string | null = null;
    try {
      if (!candidata.created_by_user_id) throw new Error("atendente_removido");
      const { data: membro } = await db
        .from("user_organizations")
        .select("role, revoked_at")
        .eq("organization_id", candidata.organization_id)
        .eq("user_id", candidata.created_by_user_id)
        .is("revoked_at", null)
        .maybeSingle();
      if (!membro || !roleAtLeast(membro.role, "agent")) throw new Error("atendente_sem_acesso");

      const { data: conversa } = await db
        .from("conversations")
        .select("id, status, last_inbound_at, channel_sessions:channel_session_id(provider)")
        .eq("organization_id", candidata.organization_id)
        .eq("id", candidata.conversation_id)
        .maybeSingle();
      if (!conversa || conversa.status === "closed") throw new Error("conversa_encerrada");
      const sessao = conversa.channel_sessions as unknown as { provider: string } | null;
      if (!canalAceitaTextoLivreAgora(sessao?.provider, conversa.last_inbound_at, new Date())) {
        throw new Error("janela_fechada");
      }

      const mensagem = await sendMessageHandler(
        db,
        {
          organization_id: candidata.organization_id,
          actor: { type: "user", id: candidata.created_by_user_id },
          internalMessageId: candidata.id,
          requestId: `scheduled-message:${candidata.id}`,
        },
        {
          conversation_id: candidata.conversation_id,
          type: "text",
          body: candidata.body,
        },
      );
      messageId = mensagem.id;
      if (mensagem.status === "failed") throw new Error("envio_falhou");
      final = "dispatched";
    } catch (err) {
      code =
        err instanceof Error && motivosConhecidos.has(err.message)
          ? err.message
          : messageId
            ? "envio_falhou"
            : "resultado_incerto";
      falhas++;
      logger.warn("[scheduled-messages] envio não concluído", {
        scheduledMessageId: candidata.id,
        reason: code,
        requestId,
      });
    }
    const { error: finishError } = await db
      .from("scheduled_messages")
      .update({
        status: final,
        message_id: messageId,
        error_code: code,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", candidata.id)
      .eq("organization_id", candidata.organization_id)
      .eq("status", "sending");
    if (finishError) {
      logger.error("[scheduled-messages] resultado não foi gravado", {
        scheduledMessageId: candidata.id,
        requestId,
        detail: finishError.message,
      });
      continue;
    }
    if (final === "dispatched") despachadas++;
    void audit({
      action: final === "dispatched" ? "message.schedule_dispatched" : "message.schedule_failed",
      actorUserId: candidata.created_by_user_id,
      organizationId: candidata.organization_id,
      resourceType: "scheduled_message",
      resourceId: candidata.id,
      requestId,
      metadata: {
        conversation_id: candidata.conversation_id,
        message_id: messageId,
        error_code: code,
      },
    });
  }
  return ok({ despachadas, falhas }, { requestId });
}
