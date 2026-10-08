/**
 * O SENTIMENTO NÃO SE ADIA DENTRO DO WEBHOOK.
 *
 * Adiar o sentimento quando o dreno roda dentro do webhook de mensagem
 * (`comOrigemDeRequest`) inverte a ordem para o cliente irritado: o turno do
 * agente sai em ~8 s (INBOUND_DEBOUNCE_MS) e o sentimento só depois do
 * adiamento (15 s, ADIAMENTO_DO_DRENO_EM_REQUEST_MS). O cliente receberia a
 * resposta da IA em vez de "uma pessoa vai te atender". Recusado na revisão do
 * PR #2130; o custo do webhook sai por outro caminho (#2337).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/workers/ai-sentiment-worker", () => ({ processSentiment: vi.fn() }));

import type { EventRow } from "@/lib/event-log/dispatcher";
import { comOrigemDeRequest } from "@/lib/event-log/origem-do-dreno";
import { processSentiment } from "@/workers/ai-sentiment-worker";
import { aiSentimentHandler } from "@/workers/ai-sentiment-worker.handler";

const row = {
  id: "e1",
  organization_id: "11111111-1111-4111-8111-111111111111",
  event_type: "message.received",
  entity_kind: "message",
  entity_id: "m1",
  payload: { message_id: "m1", conversation_id: "c1" },
} as unknown as EventRow;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(processSentiment).mockResolvedValue({ skipped: false, sentiment_score: 0.1 });
});

describe("sentimento drenado dentro do webhook", () => {
  it("mede na hora, sem adiar para depois do turno do agente", async () => {
    const r = await comOrigemDeRequest(() => aiSentimentHandler.handle(row));

    expect(processSentiment, "o sentimento foi adiado dentro do webhook").toHaveBeenCalledTimes(1);
    expect(r.status).toBe("ok");
  });
});
