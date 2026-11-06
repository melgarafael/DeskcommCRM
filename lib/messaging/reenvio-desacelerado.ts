/**
 * O PEDIDO DE NOVA TENTATIVA de uma mensagem que o canal mandou DESACELERAR.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * Quando o canal responde "devagar" (muitas mensagens para a mesma pessoa, ou a
 * conta limitada pela plataforma), o envio grava `queued` com o motivo — a
 * mensagem não tem defeito, só não pode sair AGORA. O comentário do envio
 * dizia que "o agent-engine reagenda sem consumir tentativa". Medido no código
 * em 27/10/2026, não reagendava: o ramo `queued` de `applySendOutcome` não tem
 * chamador (o turno do agente só a chama com `blocked`), o turno trata `queued`
 * como "aceita, aguardando o canal" e termina, e o resgate do watchdog só fala
 * com o transporte por QR. Ninguém mandava de novo — a resposta ao cliente
 * ficava parada até a Central acusar a "espera esquecida", quinze minutos
 * depois, numa mensagem do agente que nenhuma pessoa podia reenviar.
 *
 * ─── O que este módulo faz ──────────────────────────────────────────────────
 *
 * Só EMITE o pedido, com a espera que o canal pediu. Quem tenta de novo, na
 * MESMA linha e pelo mesmo handler de envio, é `./reenvio-desacelerado.handler.ts`.
 * Mora separado do consumidor porque o handler de envio importa este arquivo, e
 * o consumidor importa o handler de envio.
 *
 * NUNCA LANÇA: a mensagem já está gravada como `queued`, com motivo, e a Central
 * acusa a espera esquecida se este pedido se perder. Derrubar o envio por causa
 * do pedido trocaria uma mensagem atrasada por um erro na tela.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/** O evento-comando, consumido por `./reenvio-desacelerado.handler.ts`. */
export const EVENTO_REENVIO_DESACELERADO = "message.throttled_resend_requested";

/**
 * A mensagem cuja nova tentativa é DESTE reenvio — pela autoria (`sent_via`).
 *
 * Só a da pessoa (`user`) e a do agente (`ai`): não têm outro dono de nova
 * tentativa. Campanha, automação e integração (`automation`, `system`) têm o
 * próprio laço, e ele lê `failed` — a campanha devolve a pessoa à fila pelo
 * `ehLimiteDeVelocidade`. Gravar `queued` para elas deixaria a linha sem
 * ninguém para mandá-la. O envio (`messages/_handler`) e o consumidor perguntam
 * AQUI, para os dois nunca discordarem sobre quem fica esperando.
 */
export function reenvioDesaceleradoAtende(sentVia: string | null | undefined): boolean {
  return sentVia === "user" || sentVia === "ai";
}

export interface PedidoDeReenvio {
  organizationId: string;
  messageId: string;
  /** O motivo carimbado em `metadata.queued_reason` — o consumidor só age se ainda for ele. */
  queuedReason: string;
  /** A espera que o canal pediu (`Retry-After`), em ms; `null` quando não disse. */
  esperaMs: number | null;
}

export async function pedirReenvioDoDesacelerado(
  db: SupabaseClient,
  pedido: PedidoDeReenvio,
): Promise<void> {
  try {
    const { error } = await db.rpc("emit_event", {
      p_event_type: "message.throttled_resend_requested",
      p_entity_kind: "message",
      p_entity_id: pedido.messageId,
      p_payload: {
        message_id: pedido.messageId,
        queued_reason: pedido.queuedReason,
        espera_ms: pedido.esperaMs,
      },
      p_metadata: { source: "messages-send" },
      p_organization_id: pedido.organizationId,
    });
    if (error) {
      logger.warn("[reenvio-desacelerado] não consegui pedir a nova tentativa", {
        message_id: pedido.messageId,
        detail: error.message,
      });
    }
  } catch (err) {
    logger.warn("[reenvio-desacelerado] o pedido de nova tentativa lançou", {
      message_id: pedido.messageId,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
