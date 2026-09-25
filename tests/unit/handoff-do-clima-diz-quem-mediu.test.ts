/**
 * O ELO DO MEIO DO D11: o alerta de clima diz qual motor mediu, e o handler o
 * repassa à passagem.
 *
 * O worker grava `sentiment_engine` no alerta (`clima-da-conversa-no-worker`) e
 * o orquestrador escreve "(percebido pelo Jev)" quando o recebe
 * (`passagem-registro-e-dedup`). Sem este arquivo, apagar a linha do handler
 * que liga os dois deixaria os dois testes verdes e a marca sumida da tela.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) c[m] = () => c;
      c.maybeSingle = async () => ({ data: null, error: null });
      return c;
    },
  }),
}));
vi.mock("@/lib/atendimento/origem-mensagem", () => ({
  serviceFromMessage: vi.fn(async () => ({ conversation_id: "conv-1", contact_id: null })),
}));
vi.mock("@/lib/ai/handoff/orchestrator", () => ({
  triggerHandoff: vi.fn(async () => ({ triggered: true, reason: "low_sentiment" })),
}));

import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { aiHandoffFromSentimentHandler } from "@/workers/ai-handoff-from-sentiment.handler";

describe("handler do alerta de clima", () => {
  it("repassa à passagem qual motor mediu", async () => {
    await aiHandoffFromSentimentHandler.handle({
      organization_id: "org-1",
      entity_id: "msg-1",
      payload: { message_id: "msg-1", conversation_id: "conv-1", sentiment_score: 0, sentiment_engine: "jev" },
    } as unknown as EventRow);

    expect(vi.mocked(triggerHandoff).mock.calls[0]![0].metadata).toMatchObject({
      sentiment_score: 0,
      sentiment_engine: "jev",
    });
  });
});
