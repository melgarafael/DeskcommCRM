import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("ai", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, generateText: vi.fn() };
});

import { generateText } from "ai";
import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { pararAposRespostaTerminal } from "@/lib/agent-engine/agent/parada-apos-resposta";

const ORG = "22222222-2222-4222-8222-222222222222";
const generate = vi.mocked(generateText);

function poolQueGrava() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: {
              provider: "anthropic",
              default_model: "claude-padrao",
              params: {},
              enabled_models: [],
              monthly_budget_cents: null,
            },
          },
        ],
      };
    }
    if (sql.includes("from ai_purpose_bindings")) return { rows: [] };
    if (sql.includes("from ai_provider_credentials")) return { rows: [] };
    if (sql.includes("insert into llm_calls")) return { rows: [{ id: "call-obs" }] };
    return { rows: [] };
  });
  return { query } as never;
}

function modeloQueDevolvePassos() {
  const fabrica = () =>
    ({
      specificationVersion: "v3",
      provider: "anthropic",
      modelId: "claude-padrao",
      doGenerate: async () => {
        throw new Error("o seam não deve chegar no provider neste teste");
      },
    }) as never;
  return { anthropic: fabrica, openai: fabrica, google: fabrica, openrouter: fabrica };
}

describe("seam generateText — steps reais e stopWhen", () => {
  beforeEach(() => {
    generate.mockReset();
  });

  it("encaminha steps do SDK e combina teto com parada após send_message", async () => {
    const steps = [
      {
        stepNumber: 0,
        finishReason: "tool-calls",
        toolCalls: [{ toolName: "send_message" }],
        toolResults: [{ toolName: "send_message", output: { ok: true, status: "enviada" } }],
      },
    ];
    generate.mockResolvedValueOnce({
      text: "texto descartado",
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      steps,
      finishReason: "stop",
    } as never);

    const out = await runModelCall(
      poolQueGrava(),
      { anthropicApiKey: "fake-not-a-real-key", cacheTtl: "1h" },
      {
        tenantId: ORG,
        purpose: "agent_preview",
        messages: [{ role: "user", content: "oi" }],
        maxSteps: 8,
        pararQuando: pararAposRespostaTerminal({ maxEnviosAutorizados: 1 }),
      },
      { registry: modeloQueDevolvePassos() },
    );

    expect(out.steps).toHaveLength(1);
    expect(out.steps?.[0]).toEqual(expect.objectContaining({ finishReason: "tool-calls" }));
    expect(out.result.steps).toHaveLength(1);
    const args = generate.mock.calls[0]?.[0] as { stopWhen?: unknown };
    expect(Array.isArray(args.stopWhen)).toBe(true);
    expect(args.stopWhen as unknown[]).toHaveLength(2);
    expect(JSON.stringify(out)).not.toMatch(/sk-[A-Za-z0-9]|ANTHROPIC_API_KEY/i);
  });

  it("classificador sem teto não força stopWhen — o default do SDK permanece", async () => {
    generate.mockResolvedValueOnce({
      text: "ok",
      usage: {
        inputTokens: 4,
        outputTokens: 1,
        inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      steps: [],
      finishReason: "stop",
    } as never);
    await runModelCall(
      poolQueGrava(),
      { anthropicApiKey: "fake-not-a-real-key", cacheTtl: "1h" },
      {
        tenantId: ORG,
        purpose: "stage_classifier",
        messages: [{ role: "user", content: "oi" }],
      },
      { registry: modeloQueDevolvePassos() },
    );
    const args = generate.mock.calls.at(-1)?.[0] as { stopWhen?: unknown };
    expect(args.stopWhen).toBeUndefined();
  });
});
