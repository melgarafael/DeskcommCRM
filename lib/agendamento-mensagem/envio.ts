/**
 * ENVIO DE UMA OCORRÊNCIA DE TEXTO AGENDADO.
 *
 * Usa o mesmo `sendMessageHandler` das campanhas e das automações: a guarda de
 * organização suspensa, a janela do canal, o ledger de envio e a auditoria valem
 * aqui também. Só tenta enviar quando o número está WORKING; fora disso o cron
 * decide (esperar ou pular).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beginServiceAtOrigin } from "@/lib/atendimento/origem";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { OrgNaoOperanteError } from "@/lib/organizacao/operante";

export interface AgendamentoParaEnvio {
  id: string;
  organization_id: string;
  contact_id: string;
  channel_session_id: string;
  body: string;
}

export type DesfechoDoEnvio =
  | { desfecho: "enviada"; message_id: string }
  | { desfecho: "falhou"; erro: string }
  | { desfecho: "pulada_desconectado" }
  /** Org suspensa, redigida ou arquivada no meio do envio: nada é gravado; a ocorrência espera. */
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

export async function enviarOcorrencia(
  admin: SupabaseClient,
  ag: AgendamentoParaEnvio,
  previstaPara: Date,
): Promise<DesfechoDoEnvio> {
  if (!(await sessaoEstaConectada(admin, ag.organization_id, ag.channel_session_id))) {
    return { desfecho: "pulada_desconectado" };
  }
  try {
    const boundary = await beginServiceAtOrigin(admin, ag.organization_id, ag.contact_id, ag.channel_session_id);
    const chave = `scheduled:${ag.id}:${previstaPara.toISOString()}`;
    const message = await sendMessageHandler(
      admin,
      {
        organization_id: ag.organization_id,
        serviceBoundary: boundary,
        proactiveContext: { organizationId: ag.organization_id, contactId: ag.contact_id },
        actor: { type: "webhook_source", id: `scheduled:${ag.id}` },
        requestId: chave,
      } as Parameters<typeof sendMessageHandler>[1],
      {
        conversation_id: boundary.conversation_id,
        type: "text",
        body: ag.body,
        metadata: { source: "scheduled_message", scheduled_message_id: ag.id, idempotency_key: chave },
      } as unknown as Parameters<typeof sendMessageHandler>[2],
    );
    const estado = (message as unknown as { status?: string }).status;
    if (estado === "failed") return { desfecho: "falhou", erro: "envio_recusado" };
    return { desfecho: "enviada", message_id: (message as unknown as { id: string }).id };
  } catch (err) {
    if (err instanceof OrgNaoOperanteError) return { desfecho: "org_parada" };
    const erro = err instanceof Error ? err.message : "erro_desconhecido";
    return { desfecho: "falhou", erro: erro.slice(0, 200) };
  }
}
