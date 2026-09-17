import { describe, expect, it } from "vitest";

import {
  contarPassosDoGenerateText,
  nomesChamadosDoGenerateText,
  observarGenerateText,
  somarUsoDasChamadas,
} from "./uso-do-run";

describe("somarUsoDasChamadas", () => {
  it("soma cinco llm_calls de teste exatamente uma vez", () => {
    const chamadas = [
      {
        callId: "c1",
        purpose: "stage_classifier",
        usage: { inputTokens: 432, outputTokens: 18 },
        costCents: 0.0522,
        latencyMs: 400,
      },
      {
        callId: "c2",
        purpose: "jailbreak_detect",
        usage: { inputTokens: 328, outputTokens: 22 },
        costCents: 0.0438,
        latencyMs: 350,
      },
      {
        callId: "c3",
        purpose: "promise_semantic",
        usage: { inputTokens: 490, outputTokens: 31 },
        costCents: 0.0645,
        latencyMs: 900,
      },
      {
        callId: "c4",
        purpose: "agent_preview",
        usage: { inputTokens: 9977, outputTokens: 298 },
        costCents: 1.1467,
        latencyMs: 4000,
      },
      {
        callId: "c5",
        purpose: "checkpoint",
        usage: { inputTokens: 2768, outputTokens: 244 },
        costCents: 0.3988,
        latencyMs: 1500,
      },
    ];
    const uso = somarUsoDasChamadas(chamadas);
    expect(uso.llm_purposes).toEqual([
      "stage_classifier",
      "jailbreak_detect",
      "promise_semantic",
      "agent_preview",
      "checkpoint",
    ]);
    expect(uso.llm_call_ids).toHaveLength(5);
    expect(uso.tokens_in).toBe(432 + 328 + 490 + 9977 + 2768);
    expect(uso.tokens_out).toBe(18 + 22 + 31 + 298 + 244);
    expect(uso.cost_cents).toBeCloseTo(0.0522 + 0.0438 + 0.0645 + 1.1467 + 0.3988, 6);
    expect(uso.llm_latency_ms).toBe(400 + 350 + 900 + 4000 + 1500);
    const deNovo = somarUsoDasChamadas([...chamadas, chamadas[3]!]);
    expect(deNovo.tokens_in).toBe(uso.tokens_in);
    expect(deNovo.llm_call_ids).toHaveLength(5);
  });
});

describe("observabilidade dos passos", () => {
  it("steps_count corresponde aos passos simulados e só registra nomes", () => {
    const result = {
      steps: [
        { toolCalls: [{ toolName: "send_message", args: { body: "segredo" } }] },
        { toolCalls: [] },
      ],
    };
    expect(contarPassosDoGenerateText(result)).toBe(2);
    expect(nomesChamadosDoGenerateText(result)).toEqual(["send_message"]);
    expect(JSON.stringify(nomesChamadosDoGenerateText(result))).not.toContain("segredo");
  });

  it("lê steps reais do AI SDK 7 (finishReason por passo) e não estima por tokens", () => {
    const result = {
      usage: { inputTokens: 6915, outputTokens: 282 },
      steps: [
        {
          stepNumber: 0,
          finishReason: "tool-calls",
          toolCalls: [{ toolName: "search_knowledge" }],
        },
        {
          stepNumber: 1,
          finishReason: "tool-calls",
          toolCalls: [{ toolName: "send_message", input: { body: "PII" } }],
        },
      ],
    };
    const obs = observarGenerateText(result);
    expect(obs.steps_count).toBe(2);
    expect(obs.tools_called).toEqual(["search_knowledge", "send_message"]);
    expect(obs.steps).toEqual([
      { index: 0, tools: ["search_knowledge"], finish_reason: "tool-calls" },
      { index: 1, tools: ["send_message"], finish_reason: "tool-calls" },
    ]);
    expect(JSON.stringify(obs)).not.toContain("PII");
    expect(observarGenerateText({ usage: { inputTokens: 6915 } } as never).steps_count).toBe(0);
  });

  it("usa a cópia do seam quando o adapter projetou só texto/usage", () => {
    const steps = [
      { stepNumber: 0, finishReason: "tool-calls", toolCalls: [{ toolName: "send_message" }] },
    ];
    const obs = observarGenerateText({}, steps);
    expect(obs.steps_count).toBe(1);
    expect(obs.tools_called).toEqual(["send_message"]);
  });
});
