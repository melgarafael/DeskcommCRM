import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Cerca anti-regressão da #2090: os auxiliares do agente que liam JSON do
 * modelo como TEXT foram migrados para `extrairJsonDoTexto` (o parser robusto
 * que sobrevive a cerca de código, prosa e repetição que modelos OpenRouter
 * produzem). Se alguém voltar a **escrever** o parser frágil (`JSON.parse` num
 * `text.slice` entre o primeiro `{` e o último `}`) num destes arquivos, o
 * sintoma "JSON inválido / texto repetido" reaparece só em produção.
 *
 * A marca verificada é EXECUTÁVEL (`JSON.parse(text.slice…`), não textual: os
 * docstrings de origem citam `lastIndexOf('}')` em comentário e não devem ter
 * peso aqui.
 */
const MIGRADOS: ReadonlyArray<{ caminho: string; helper: string }> = [
  { caminho: "lib/agent-engine/agent/compaction.ts", helper: "@/lib/agent-engine/texto/extrair-json-do-texto" },
  { caminho: "lib/agent-engine/agent/abertura/checkpoint.ts", helper: "@/lib/agent-engine/texto/extrair-json-do-texto" },
  { caminho: "lib/agent-engine/flywheel/live.ts", helper: "@/lib/agent-engine/texto/extrair-json-do-texto" },
  { caminho: "lib/agent-engine/agent/intent-classifier.ts", helper: "@/lib/agent-engine/texto/extrair-json-do-texto" },
  // #2124 — os seis leitores restantes (cinco arquivos; followup-flow-classify tem dois).
  { caminho: "lib/onboarding/sugerir-funil.ts", helper: "@/lib/agent-engine/texto/extrair-json-do-texto" },
  { caminho: "lib/agent-engine/agent/flow-validate.ts", helper: "@/lib/agent-engine/texto/extrair-json-do-texto" },
  { caminho: "lib/agent-engine/agent/followup-flow-classify.ts", helper: "@/lib/agent-engine/texto/extrair-json-do-texto" },
  { caminho: "lib/agent-engine/guardrails/jailbreak/classifier.ts", helper: "@/lib/agent-engine/texto/extrair-json-do-texto" },
  { caminho: "lib/agent-engine/guardrails/promise/semantic.ts", helper: "@/lib/agent-engine/texto/extrair-json-do-texto" },
];

describe("extrair-json-do-texto — a cerca do dono (nenhum parser frágil re-germina)", () => {
  it("todos os arquivos migrados importam o parser robusto", () => {
    for (const { caminho, helper } of MIGRADOS) {
      const fonte = readFileSync(caminho, "utf8");
      expect(
        fonte.includes(helper),
        `${caminho} deve rotear o JSON de modelo por ${helper}`,
      ).toBe(true);
    }
  });

  it("nenhum dos arquivos migrados tem o parser frágil executável de volta", () => {
    for (const { caminho } of MIGRADOS) {
      const fonte = readFileSync(caminho, "utf8");
      expect(
        fonte.includes("JSON.parse(text.slice"),
        `${caminho} re-criou o slice frágil (JSON.parse sobre text.slice)`,
      ).toBe(false);
      expect(
        fonte.includes("lastIndexOf('}')") &&
          fonte.includes("JSON.parse("),
        `${caminho} mistura lastIndexOf('}') com JSON.parse — provável parser frágil`,
      ).toBe(false);
    }
  });
});