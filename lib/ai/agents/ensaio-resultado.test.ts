import { describe, expect, it } from "vitest";

import { newPreviewResult, somarUsoNoPreview, type TurnPreview } from "@/lib/agent-engine/agent/preview";
import {
  AVISO_RESPOSTA_NAO_ENVIADA,
  formatarCentavos,
  montarPayloadDoEnsaio,
  statusHttpDoEnsaio,
} from "./ensaio-resultado";
import { somarUsoDasChamadas } from "@/lib/agent-engine/agent/uso-do-run";

/** Ensaio isolado: 4 llm_calls reais, sem checkpoint. 432+328+490+3500 = 4750. */
const CHAMADAS_ISOLADAS = [
  {
    callId: "c1",
    purpose: "stage_classifier",
    usage: { inputTokens: 432, outputTokens: 18 },
    costCents: 0.0522,
  },
  {
    callId: "c2",
    purpose: "jailbreak_detect",
    usage: { inputTokens: 328, outputTokens: 22 },
    costCents: 0.0438,
  },
  {
    callId: "c3",
    purpose: "promise_semantic",
    usage: { inputTokens: 490, outputTokens: 31 },
    costCents: 0.0645,
  },
  {
    callId: "c4",
    purpose: "agent_preview",
    usage: { inputTokens: 3500, outputTokens: 120 },
    costCents: 0.4,
  },
] as const;

describe("contrato JSON do ensaio", () => {
  it("preserva a resposta gerada quando só a entrega operacional bloqueia", () => {
    const result = newPreviewResult();
    result.candidates.push({
      body: "Olá, posso ajudar com o pedido.",
      citations: [],
      trace: [],
    });
    result.delivery_status = "blocked";
    result.delivery_impediments.push({
      classe: "entrega",
      code: "outside_window",
      gate: "pacing",
      message: "Fora da janela de envio 7h–22h",
    });
    result.tokens_in = 15707;
    result.tokens_out = 613;
    result.cost_cents = 1.8772;
    result.latency_ms = 4120;
    const payload = montarPayloadDoEnsaio("run-1", result, { stub: false, wallMs: 5000 });
    expect(payload).toMatchObject({
      run_id: "run-1",
      status: "blocked",
      generated_response: "Olá, posso ajudar com o pedido.",
      delivery_status: "blocked",
      notice: AVISO_RESPOSTA_NAO_ENVIADA,
      tokens_in: 15707,
      tokens_out: 613,
      cost_cents: 1.8772,
      latency_ms: 5000,
      llm_latency_ms: 0,
    });
    expect(payload.delivery_impediments).toEqual([
      expect.objectContaining({ code: "outside_window", message: "Fora da janela de envio 7h–22h" }),
    ]);
    expect(statusHttpDoEnsaio("blocked")).toBe("blocked");
    expect(statusHttpDoEnsaio("allowed")).toBe("ok");
    expect(payload.llm_purposes).toEqual([]);
    expect(payload.tool_calls).toEqual({ offered: [], called: [] });
    expect(payload.checkpoint_generated).toBe(true);
    expect(payload.checkpoint_omitted_reason).toBeNull();
    expect(payload.checkpoint_notice).toBeNull();
    expect(JSON.stringify(payload.tool_calls)).not.toMatch(/body|prompt|sk-/i);
  });

  it("não coloca conteúdo inseguro em generated_response", () => {
    const result = newPreviewResult();
    result.delivery_status = "withheld";
    result.security_impediments.push({
      classe: "seguranca",
      code: "internal_vocabulary_leak",
      gate: "internal_vocabulary",
      message: "A resposta usaria palavras internas",
    });
    const payload = montarPayloadDoEnsaio("run-2", result, { stub: false, wallMs: 10 });
    expect(payload.generated_response).toBeNull();
    expect(payload.final_text).toBeNull();
    expect(payload.delivery_status).toBe("withheld");
    expect(JSON.stringify(payload)).not.toContain("crm_list_leads");
  });

  it("copia tokens e custo uma única vez a partir do uso já gravado em llm_calls", () => {
    const preview = {
      result: newPreviewResult(),
    } as TurnPreview;
    somarUsoNoPreview(preview, {
      callId: "c1",
      purpose: "agent_preview",
      usage: { inputTokens: 15707, outputTokens: 613 },
      costCents: 1.8772,
      latencyMs: 4000,
    });
    somarUsoNoPreview(preview, {
      callId: "c2",
      purpose: "checkpoint",
      usage: { inputTokens: 0, outputTokens: 0 },
      costCents: 0,
      latencyMs: 120,
    });
    expect(preview.result.tokens_in).toBe(15707);
    expect(preview.result.tokens_out).toBe(613);
    expect(preview.result.cost_cents).toBe(1.8772);
    expect(preview.result.llm_latency_ms).toBe(4120);
    expect(preview.result.latency_ms).toBe(0);
    expect(preview.result.llm_purposes).toEqual(["agent_preview", "checkpoint"]);
  });

  it("ensaio isolado registra que checkpoint não foi gerado e não o inventa", () => {
    const result = newPreviewResult();
    result.candidates.push({
      body: "O Sigilium é um CRM.",
      citations: [],
      trace: [],
    });
    const uso = somarUsoDasChamadas([...CHAMADAS_ISOLADAS]);
    result.tokens_in = uso.tokens_in;
    result.tokens_out = uso.tokens_out;
    result.cost_cents = uso.cost_cents;
    result.llm_purposes = uso.llm_purposes;
    result.checkpoint_omitted = true;
    result.checkpoint_omitted_reason = "isolated_run";
    const payload = montarPayloadDoEnsaio("run-iso", result, { stub: false, wallMs: 2000 });
    expect(uso.tokens_in).toBe(432 + 328 + 490 + 3500);
    expect(uso.tokens_out).toBe(18 + 22 + 31 + 120);
    expect(payload.generated_response).toBe("O Sigilium é um CRM.");
    expect(payload.checkpoint_generated).toBe(false);
    expect(payload.checkpoint_omitted_reason).toBe("isolated_run");
    expect(payload.checkpoint_notice).toMatch(/isolad/i);
    expect(payload.llm_purposes).not.toContain("checkpoint");
    expect(payload).not.toHaveProperty("checkpoint");
    expect(JSON.stringify(payload)).not.toMatch(/rolling_summary|sk-/i);
    expect(payload.cost_cents).toBe(formatarCentavos(uso.cost_cents));
    expect(payload.cost_cents).not.toBe(1.3674);
    expect(payload).toEqual(
      expect.objectContaining({
        steps_count: 0,
        tools_offered: [],
        tools_called: [],
        llm_purposes: [
          "stage_classifier",
          "jailbreak_detect",
          "promise_semantic",
          "agent_preview",
        ],
        llm_latency_ms: 0,
        tokens_in: uso.tokens_in,
        tokens_out: uso.tokens_out,
        checkpoint_generated: false,
      }),
    );
  });

  it("nunca omite as chaves de observabilidade e arredonda o custo só na apresentação", () => {
    expect(formatarCentavos(1.3674000000000002)).toBe(1.3674);
    const uso = somarUsoDasChamadas([...CHAMADAS_ISOLADAS]);
    const result = newPreviewResult();
    result.cost_cents = uso.cost_cents;
    result.tokens_in = uso.tokens_in;
    result.tokens_out = uso.tokens_out;
    result.llm_purposes = uso.llm_purposes;
    result.llm_latency_ms = 2000;
    result.steps_count = 1;
    result.tools_offered = ["request_human_handoff", "send_message"];
    result.tools_called = ["send_message"];
    result.checkpoint_omitted = true;
    const payload = montarPayloadDoEnsaio("run-keys", result, { stub: false, wallMs: 2100 });
    for (const chave of [
      "steps_count",
      "tools_offered",
      "tools_called",
      "llm_purposes",
      "checkpoint_generated",
      "checkpoint_notice",
      "tokens_in",
      "tokens_out",
      "cost_cents",
      "latency_ms",
      "llm_latency_ms",
    ]) {
      expect(payload, chave).toHaveProperty(chave);
    }
    expect(payload.tokens_in).toBe(4750);
    expect(payload.cost_cents).toBe(formatarCentavos(0.0522 + 0.0438 + 0.0645 + 0.4));
    expect(payload.cost_cents).not.toBe(1.3674);
    expect(String(payload.cost_cents)).not.toContain("0000002");
    expect(payload.tools_offered).toEqual(["request_human_handoff", "send_message"]);
    expect(payload.tools_called).toEqual(["send_message"]);
  });
});
