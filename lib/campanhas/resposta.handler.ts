/**
 * Adapter fino que pluga a atribuição de resposta no dispatcher do `event_log`
 * — mesmo padrão de `lib/followup/reactivity.handler.ts`.
 *
 * Consome o evento canônico `message.received`, que é emitido pelo TRIGGER de
 * `messages` (e não pelo ingest de canal): assim vale para qualquer caminho de
 * entrada, hoje e amanhã, sem a campanha conhecer provider nenhum.
 *
 * Nunca lança: falha aqui vira `error` para o dispatcher, que aplica o backoff
 * dele. A resposta do cliente já está no inbox de qualquer jeito — o que se
 * perde numa falha é a métrica, não a conversa.
 */
import { aplicarRespostaNaCampanha } from "@/lib/campanhas/resposta";
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";

export const CAMPANHA_RESPOSTA_HANDLER_KEY = "campanha-resposta.v1";

export const campanhaRespostaHandler: EventHandler = {
  key: CAMPANHA_RESPOSTA_HANDLER_KEY,
  events: ["message.received"],
  async handle(row): Promise<HandlerResult> {
    const contactId = typeof row.payload.contact_id === "string" ? row.payload.contact_id : null;
    if (!contactId) {
      return {
        consumer_key: CAMPANHA_RESPOSTA_HANDLER_KEY,
        status: "skipped",
        detail: "evento sem contact_id",
      };
    }

    try {
      const resumo = await aplicarRespostaNaCampanha(createAdminClient(), {
        organizationId: row.organization_id,
        contactId,
        // A hora da MENSAGEM, não a do consumo: o drain pode rodar minutos
        // depois, e usar `now()` faria uma resposta na borda da janela de 72h
        // cair fora por causa do atraso da fila.
        recebidoEm: momentoDoEvento(row),
      });
      return {
        consumer_key: CAMPANHA_RESPOSTA_HANDLER_KEY,
        // `skipped` quando não havia campanha a fechar — que é o caso comum de
        // toda instalação que não está prospectando. Marcar `ok` ali encheria o
        // log de sucesso sobre nada feito.
        status: resumo.atribuiu || resumo.optOut > 0 ? "ok" : "skipped",
        detail: `atribuiu=${resumo.atribuiu} opt_out=${resumo.optOut}`,
      };
    } catch (err) {
      return {
        consumer_key: CAMPANHA_RESPOSTA_HANDLER_KEY,
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

/** Quando a mensagem chegou, com o `created_at` do evento como piso. */
function momentoDoEvento(row: { created_at?: string | Date | null }): Date {
  if (row.created_at) {
    const d = new Date(row.created_at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}
