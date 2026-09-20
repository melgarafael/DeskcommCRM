import { expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ query: vi.fn(), generate: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: m.query }),
}));
vi.mock("@/lib/ai/render-system-prompt", () => ({ renderSystemPrompt: () => "Atenda" }));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  generateText: m.generate,
}));
import { invokeBot } from "@/workers/ai-response-worker";

it("settles using the resolved provider and model, not the agent's saved model", async () => {
  m.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes("select provider_subscription_id"))
      return { rows: [{ provider_subscription_id: "sub_paid" }] };
    if (sql.includes("fn_reserve_subscription_ai"))
      return { rows: [{ reservation_id: params[1] }] };
    if (sql.includes("from ai_models"))
      return {
        rows: [{ input_price_per_million_cents: 100, output_price_per_million_cents: 200 }],
      };
    return { rows: [] };
  });
  m.generate.mockResolvedValue({
    text: "Resposta",
    usage: { inputTokens: 1000, outputTokens: 200 },
    finishReason: "stop",
  });
  const model = { modelId: "selected-model", provider: "openrouter" };
  const result = await invokeBot(
    {
      organization_id: "11111111-1111-4111-8111-111111111111",
      agent: { model: "openai/gpt-5.6-terra", system_prompt: "Atenda" },
      recent_messages: [],
      inbound_body: "Olá",
      retrieved_chunks: [],
    } as never,
    { model: model as never, provider: "openrouter", modelId: "selected-model", origem: "binding" },
  );
  expect(result.text).toBe("Resposta");
  expect(m.generate).toHaveBeenCalledWith(expect.objectContaining({ model }));
  expect(m.query).toHaveBeenCalledWith(expect.stringContaining("from ai_models"), [
    "openrouter",
    ["selected-model"],
    "selected-model",
  ]);
  expect(m.query).toHaveBeenCalledWith("select fn_settle_subscription_ai($1,$2,$3)", [
    "11111111-1111-4111-8111-111111111111",
    expect.any(String),
    0.14,
  ]);
});
