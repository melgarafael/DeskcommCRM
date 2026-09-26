/**
 * A falha de ENTREGA deixa de ser muda (#1614).
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 *
 * A Meta aceita a chamada (200, a linha vira `sent`) e recusa a entrega DEPOIS,
 * pelo webhook de status, com 131047. Quem integra via token via o 201, registra
 * "cobrança enviada" e nunca fica sabendo: a linha vira `failed` sozinha e o
 * sistema do lado de fora não lê o nosso banco.
 *
 * O gatilho `message.failed` é o que fecha isso — mas ele só existe de verdade
 * quando emite o EVENTO. Este módulo é o único ponto que faz isso para o caso
 * da entrega recusada, e ele existe separado por um motivo prático: o webhook
 * da Meta e o `catch` do envio são dois caminhos diferentes que precisam do
 * MESMO payload, e dois payloads parecidos envelhecem em direções diferentes.
 *
 * ─── Por que "uma vez" ─────────────────────────────────────────────────────
 *
 * A Meta reentrega o mesmo status callback enquanto não recebe 2xx. Cada
 * reentrega atualizaria a linha de novo e emitiaria de novo — e uma regra de
 * automação com ação de webhook avisaria o sistema do integrador N vezes sobre
 * a mesma falha. O "uma vez" não é negociável aqui: o chamador só emite quando
 * a linha ESTAVA fora de `failed` (ver `neq("status", "failed")` na rota do
 * webhook). Neste módulo não há o que guardar — ele emite o que o chamador
 * acabou de confirmar que aconteceu.
 *
 * `emit_event` é fire-and-forget de propósito: perder o aviso não pode virar
 * erro num envio que JÁ FALHOU — seria trocar um problema pelo outro. A falha
 * da emissão vai para o log, que é onde ela é acionável.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/** O que o integrador precisa ler sem fazer segunda consulta. */
export interface FalhaDeEntrega {
  message_id: string;
  conversation_id: string | null;
  /** `messages.contact_id` — é dele que o motor hidrata `contact.*` nas condições. */
  contact_id: string | null;
  /**
   * O contato em forma que o sistema de fora já conhece (o telefone), porque a
   * primeira pergunta de quem recebe o aviso é "de quem era?" — e o nosso uuid
   * não responde. `null` quando a linha não trouxe (webhook por `external_id`).
   */
  contact: string | null;
  sent_via: string | null;
  /** `codigo` é o que se compara; `titulo` é o que se LÊ. */
  erro: { codigo: string; titulo: string | null };
}

/** O embed `contacts:contact_id(phone_number)` como pode chegar. */
export type EmbedDoContato =
  | { phone_number: string | null }
  | { phone_number: string | null }[]
  | null
  | undefined;

/**
 * O telefone do embed N:1 do contato. Em tempo de execução o PostgREST devolve
 * OBJETO (a FK aponta para uma linha só), mas a tipagem gerada diz lista — ler
 * `[0]` de um objeto dá `undefined` e o aviso sairia sempre sem telefone.
 */
export function telefoneDoEmbed(embed: EmbedDoContato): string | null {
  const contato = Array.isArray(embed) ? embed[0] : embed;
  return contato?.phone_number ?? null;
}

export interface EmitirFalhaArgs {
  organizationId: string;
  falha: FalhaDeEntrega;
  /** De onde veio a falha — fica no `metadata` e é o que distingue os dois caminhos. */
  source: string;
  requestId?: string;
}

/**
 * Emite `message.failed` (entity_kind `message`) — nunca lança.
 *
 * `entity_kind: "message"` e `payload.contact_id` não são detalhe: são os dois
 * lados do mesmo contrato (`ENTIDADE_ESPERADA_POR_GATILHO` e `buildContext` em
 * `lib/automation/engine.ts`). Sem o primeiro o motor descarta o evento como
 * `entity_kind_mismatch`; sem o segundo, `contact.tags` na condição da regra
 * nunca casa — e a regra "roda" sobre um contexto sem contato.
 */
export async function emitirFalhaDeEntrega(
  admin: SupabaseClient,
  args: EmitirFalhaArgs,
): Promise<void> {
  try {
    const { error } = await admin.rpc("emit_event", {
      p_event_type: "message.failed",
      p_entity_kind: "message",
      p_entity_id: args.falha.message_id,
      p_payload: { ...args.falha },
      p_metadata: {
        source: args.source,
        ...(args.requestId ? { request_id: args.requestId } : {}),
      },
      p_organization_id: args.organizationId,
    });
    if (error) {
      logger.warn("[falha-de-entrega] emit message.failed falhou", {
        error: error.message,
        message_id: args.falha.message_id,
        requestId: args.requestId,
      });
    }
  } catch (err) {
    logger.warn("[falha-de-entrega] emit message.failed lançou", {
      error: err instanceof Error ? err.message : String(err),
      message_id: args.falha.message_id,
      requestId: args.requestId,
    });
  }
}
