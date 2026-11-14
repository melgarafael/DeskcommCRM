/**
 * ENCAMINHAMENTO DE UMA MENSAGEM DE TEXTO AGENDADA.
 *
 * Usa o mesmo `sendMessageHandler` das campanhas e das automações: a guarda de
 * organização suspensa, o contato que pediu para não receber (`is_blocked`), a
 * janela do canal oficial e a auditoria do envio valem aqui também.
 *
 * O desfecho é `encaminhada`, nunca "enviada": o handler devolve a linha de
 * `messages`, e ela pode estar em `queued` esperando o canal. Quem diz se saiu é
 * o `status` dessa mensagem, lido pela tela através de `message_id`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { beginServiceAtOrigin } from "@/lib/atendimento/origem";
import { roleAtLeast } from "@/lib/auth/types";
import { OrgNaoOperanteError } from "@/lib/organizacao/operante";
import type { SendMessageInput } from "@/lib/schemas";

export interface AgendamentoParaEnvio {
  id: string;
  organization_id: string;
  contact_id: string;
  channel_session_id: string;
  created_by_user_id: string | null;
  body: string;
}

export type DesfechoDoEnvio =
  | { desfecho: "encaminhada"; message_id: string }
  | { desfecho: "falhou"; motivo: string }
  /** Org suspensa, redigida ou arquivada no meio do envio: nada é gravado; o envio espera. */
  | { desfecho: "org_parada" };

export async function sessaoEstaConectada(admin: SupabaseClient, organizationId: string, sessionId: string): Promise<boolean> {
  const { data } = await admin
    .from("channel_sessions")
    .select("status")
    .eq("id", sessionId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  return data?.status === "WORKING";
}

/**
 * Quem agendou ainda é da equipe, com papel de atendente ou acima? Conferido na
 * HORA do envio: quem saiu da empresa não continua mandando mensagem por ela.
 *
 * ponytail: confere o vínculo e o papel, não a visibilidade da conversa. A
 * conversa transferida continua mostrando o agendamento para quem a atende
 * agora (a leitura segue a RLS da conversa), e é essa pessoa quem cancela.
 */
export async function autorAindaTemAcesso(admin: SupabaseClient, ag: AgendamentoParaEnvio): Promise<boolean> {
  if (!ag.created_by_user_id) return false;
  const { data, error } = await admin
    .from("user_organizations")
    .select("role")
    .eq("organization_id", ag.organization_id)
    .eq("user_id", ag.created_by_user_id)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw new Error(`leitura_do_vinculo_falhou: ${error.message}`);
  return roleAtLeast(data?.role, "agent");
}

export async function encaminharAgendamento(admin: SupabaseClient, ag: AgendamentoParaEnvio): Promise<DesfechoDoEnvio> {
  try {
    const boundary = await beginServiceAtOrigin(admin, ag.organization_id, ag.contact_id, ag.channel_session_id);
    const chave = `scheduled:${ag.id}`;
    const ctx: HandlerCtx = {
      organization_id: ag.organization_id,
      serviceBoundary: boundary,
      actor: { type: "webhook_source", id: `scheduled:${ag.id}` },
      // O id da mensagem é o do agendamento: se a rodada cair depois do envio e
      // antes de gravar o desfecho, a próxima reencontra a MESMA linha em vez de
      // mandar de novo (o handler devolve a linha já enviada no 23505).
      internalMessageId: ag.id,
      requestId: chave,
    };
    const input: SendMessageInput = {
      conversation_id: boundary.conversation_id,
      type: "text",
      body: ag.body,
      metadata: { source: "scheduled_message", scheduled_message_id: ag.id, idempotency_key: chave },
    };
    const message = await sendMessageHandler(admin, ctx, input);
    if (message.status === "failed") return { desfecho: "falhou", motivo: "envio_recusado" };
    return { desfecho: "encaminhada", message_id: message.id };
  } catch (err) {
    if (err instanceof OrgNaoOperanteError) return { desfecho: "org_parada" };
    // Só o CÓDIGO: a mensagem de erro pode citar o contato, e a linha fica legível na tela.
    return { desfecho: "falhou", motivo: err instanceof ApiError ? err.code : "erro_no_envio" };
  }
}
