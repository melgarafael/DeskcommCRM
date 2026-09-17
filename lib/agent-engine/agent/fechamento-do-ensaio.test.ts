import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AVISO_CHECKPOINT_OMITIDO_ENSAIO,
  deveGerarCheckpointDoFechamento,
  MOTIVO_CHECKPOINT_OMITIDO_ENSAIO,
  omitirCheckpointDoEnsaio,
} from "./fechamento-do-ensaio";
import { newPreviewResult } from "./preview";
import { somarUsoDasChamadas } from "./uso-do-run";

describe("deveGerarCheckpointDoFechamento", () => {
  it("atendimento real continua fechando com checkpoint", () => {
    expect(deveGerarCheckpointDoFechamento(undefined)).toBe(true);
    expect(deveGerarCheckpointDoFechamento(null)).toBe(true);
    expect(deveGerarCheckpointDoFechamento({})).toBe(true);
  });

  it("dry-run isolado não gera checkpoint", () => {
    expect(deveGerarCheckpointDoFechamento({ isolated: true })).toBe(false);
  });

  it("preview assistido e sandbox de governança continuam fechando", () => {
    expect(deveGerarCheckpointDoFechamento({ isolated: false })).toBe(true);
  });
});

describe("omitirCheckpointDoEnsaio", () => {
  it("não inventa checkpoint e registra o motivo isolado", () => {
    const result = newPreviewResult();
    result.candidates.push({ body: "O Sigilium é um CRM.", citations: [], trace: [] });
    omitirCheckpointDoEnsaio(result);
    expect(result.checkpoint).toBeUndefined();
    expect(result.checkpoint_omitted).toBe(true);
    expect(result.checkpoint_omitted_reason).toBe(MOTIVO_CHECKPOINT_OMITIDO_ENSAIO);
    expect(result.candidates[0]?.body).toBe("O Sigilium é um CRM.");
    expect(AVISO_CHECKPOINT_OMITIDO_ENSAIO).toMatch(/isolad/i);
  });

  it("uso total do ensaio não inclui uma chamada inexistente", () => {
    const uso = somarUsoDasChamadas([
      { callId: "c1", purpose: "stage_classifier", usage: { inputTokens: 432, outputTokens: 18 }, costCents: 0.0522 },
      { callId: "c2", purpose: "jailbreak_detect", usage: { inputTokens: 328, outputTokens: 22 }, costCents: 0.0438 },
      { callId: "c3", purpose: "promise_semantic", usage: { inputTokens: 490, outputTokens: 31 }, costCents: 0.0645 },
      { callId: "c4", purpose: "agent_preview", usage: { inputTokens: 3500, outputTokens: 120 }, costCents: 0.4 },
    ]);
    expect(uso.llm_purposes).toEqual([
      "stage_classifier",
      "jailbreak_detect",
      "promise_semantic",
      "agent_preview",
    ]);
    expect(uso.llm_purposes).not.toContain("checkpoint");
    expect(uso.tokens_in).toBe(432 + 328 + 490 + 3500);
    expect(uso.tokens_out).toBe(18 + 22 + 31 + 120);
    expect(uso.cost_cents).toBeCloseTo(0.0522 + 0.0438 + 0.0645 + 0.4, 6);
  });
});

describe("amarração no motor", () => {
  const raiz = process.cwd();

  it("dry-run isolado marca isolated; o fechamento real permanece no inbound-turn", () => {
    const sandbox = readFileSync(join(raiz, "lib/agent-engine/agent/sandbox.ts"), "utf8");
    const inbound = readFileSync(join(raiz, "lib/agent-engine/agent/inbound-turn.ts"), "utf8");
    expect(sandbox).toMatch(/isolated:\s*true/);
    expect(inbound).toContain("deveGerarCheckpointDoFechamento");
    expect(inbound).toContain("omitirCheckpointDoEnsaio");
    expect(inbound).toContain("pararAposRespostaTerminal");
    expect(inbound).toContain("observarGenerateText");
    expect(inbound).toContain("purpose: 'checkpoint'");
    expect(inbound).toContain("await insertCheckpoint");
    expect(inbound).toContain("await latestCheckpoint");
    const skipAt = inbound.indexOf("deveGerarCheckpointDoFechamento(preview)");
    const callAt = inbound.indexOf("purpose: 'checkpoint'");
    expect(skipAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(skipAt);
  });
});
