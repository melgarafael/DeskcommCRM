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
import { createHash } from "node:crypto";
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
  /** Só para série: a ocorrência é identificada pela data prevista, não só pelo agendamento. */
  recorrencia?: string | null;
  scheduled_at?: string;
}

/**
 * Id determinístico da mensagem de UMA ocorrência de série. O id do agendamento
 * é o mesmo em todas as ocorrências: reaproveitá-lo faria a 2ª ocorrência achar
 * a mensagem da 1ª no 23505 do handler e devolvê-la sem enviar nada.
 */
export function idDaOcorrencia(agendamentoId: string, previstaPara: string): string {
  const h = createHash("sha256").update(`${agendamentoId}|${previstaPara}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type DesfechoDoEnvio =
  | { desfecho: "encaminhada"; message_id: string }
  | { desfecho: "falhou"; motivo: string }
  /** Org suspensa, redigida ou arquivada no meio do envio: nada é gravado; o envio espera. */
  | { desfecho: "org_parada" };

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
    const serie = Boolean(ag.recorrencia) && ag.recorrencia !== "nenhuma" && Boolean(ag.scheduled_at);
    const idDaMensagem = serie ? idDaOcorrencia(ag.id, ag.scheduled_at as string) : ag.id;
    const chave = serie ? `scheduled:${ag.id}:${ag.scheduled_at}` : `scheduled:${ag.id}`;
    const ctx: HandlerCtx = {
      organization_id: ag.organization_id,
      serviceBoundary: boundary,
      actor: { type: "webhook_source", id: chave },
      // O id da mensagem é o da ocorrência: se a rodada cair depois do envio e
      // antes de gravar o desfecho, a próxima reencontra a MESMA linha em vez de
      // mandar de novo (o handler devolve a linha já enviada no 23505).
      internalMessageId: idDaMensagem,
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
