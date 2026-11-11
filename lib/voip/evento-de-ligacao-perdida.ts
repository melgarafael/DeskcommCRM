/**
 * O EVENTO DA LIGAÇÃO PERDIDA (#4365) — a ponte entre o worker de voz e o
 * `event_log`.
 *
 * O worker SIP sabe o que ninguém mais sabe: a ligação RECEBIDA morreu tocando
 * sem ser atendida. Até aqui esse fato só virava `voice_calls.end_reason =
 * 'timeout'` — verdade no banco e invisível para o motor de automação, que
 * escuta o `event_log`. Quem ligou para um prestador de serviço que estava
 * trabalhando não recebia nem telefonema nem mensagem.
 *
 * A publicação é INSERT direto em `event_log`, o MESMO caminho de todo produtor
 * do produto (`lib/propostas/aviso-de-revisao.ts`, `lib/wacalls/events-bridge.ts`,
 * `fn_log_event` do banco). O `dispatcher` não publica — ele é o registry de
 * QUEM CONSOME a linha; o consumidor daqui é o motor de automação, que assina
 * `TRIGGER_EVENTS` (e o tipo entra lá pelo catálogo de gatilhos).
 *
 * `entity_kind = 'contact'` porque é o CONTATO que a ação de WhatsApp precisa
 * no contexto: o `buildContext` do motor hidrata `context.contact` pela linha do
 * evento, e sem isso a regra rodaria sem saber para quem mandar. O telefone vai
 * no payload junto do `call_id` para quem consome por webhook conseguir
 * rastrear a ligação que originou o aviso.
 *
 * Sem `status`: o default é `pending`, que é o que o dreno do `event_log`
 * enxerga. Gravar `done` (como o `voice_call.ended` da ponte do WaCalls, que é
 * evento de REGISTRO) deixaria a automação sem gatilho — é exatamente o
 * contrário do que este módulo existe para fazer.
 *
 * NUNCA lança: perder o aviso é ruim, derrubar o encerramento da ligação é
 * pior. Quem chama está no meio do `ChannelDestroyed`, e a linha já está
 * gravada como encerrada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/** O tipo no `event_log`, na regra e no rótulo da tela. */
export const EVENTO_LIGACAO_PERDIDA = "voice_call.missed";

export interface ChamadaPerdida {
  organizationId: string;
  /** `voice_calls.id` — o que o webhook usa para achar a chamada. */
  callId: string;
  /** Contato resolvido pelo número de quem liga. `null` = número desconhecido. */
  contactId: string | null;
  /** O número de quem ligou, como o Asterisk entregou. */
  peerPhone: string | null;
  /** `voice_calls.end_reason` do fechamento (hoje sempre `timeout`). */
  endReason: string;
}

/** Publica `voice_call.missed`. Devolve `true` quando a linha foi gravada. */
export async function publicarLigacaoPerdida(
  admin: SupabaseClient,
  chamada: ChamadaPerdida,
): Promise<boolean> {
  try {
    const { error } = await admin.from("event_log").insert({
      organization_id: chamada.organizationId,
      event_type: EVENTO_LIGACAO_PERDIDA,
      entity_kind: "contact",
      entity_id: chamada.contactId,
      payload: {
        contact_id: chamada.contactId,
        call_id: chamada.callId,
        peer_phone: chamada.peerPhone,
        end_reason: chamada.endReason,
      },
    });
    if (error) {
      logger.warn("[voip.ligacao-perdida] ligação encerrada, mas o evento não foi publicado", {
        organization_id: chamada.organizationId,
        call_id: chamada.callId,
        error: error.message,
      });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn("[voip.ligacao-perdida] falha inesperada ao publicar o evento", {
      organization_id: chamada.organizationId,
      call_id: chamada.callId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
