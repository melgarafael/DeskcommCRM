/**
 * A LINHA DO JEV EM `llm_calls` DIZ A VERDADE nas três colunas que a tela lê.
 *
 * Sem isto, uma decisão do Jev apareceria na tela de Execuções como OpenRouter
 * (o ramo da barra do `providerDoModelo`), sem o "por que este modelo", e
 * custando 1 centavo em vez da fração real — ~600× o preço.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const inserts: Array<Record<string, unknown>> = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        inserts.push(row);
        return Promise.resolve({ error: null });
      },
    }),
  }),
}));

const { logInvocation } = await import("@/lib/ai/log-invocation");

async function drenar(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

const BASE = {
  organization_id: "11111111-1111-4111-8111-111111111111",
  agent_id: null,
  conversation_id: null,
  message_id: null,
  invocation_kind: "sentiment_classify" as const,
  model: "typesafe/jev-1.13.0",
  prompt_tokens: 388,
  completion_tokens: 18,
  latency_ms: 361,
  cost_cents: 0.0016296,
};

describe("logInvocation com o Jev", () => {
  beforeEach(() => {
    inserts.length = 0;
  });

  it("grava provider typesafe, o custo fracionário sem arredondar e os tokens reais", async () => {
    logInvocation(BASE);
    await drenar();
    expect(inserts[0]).toMatchObject({
      provider: "typesafe",
      model: "typesafe/jev-1.13.0",
      cost_cents: 0.0016296,
      input_tokens: 388,
      output_tokens: 18,
      status: "ok",
      origem_da_escolha: null,
    });
  });

  it("provider explícito vence a derivação pelo id", async () => {
    logInvocation({ ...BASE, model: "modelo-sem-fabricante", provider: "typesafe" });
    await drenar();
    expect(inserts[0]!.provider).toBe("typesafe");
  });

  it("a origem da escolha vai para a coluna que a tela de Execuções explica", async () => {
    logInvocation({ ...BASE, origem_da_escolha: "binding" });
    await drenar();
    expect(inserts[0]!.origem_da_escolha).toBe("binding");
  });
});
