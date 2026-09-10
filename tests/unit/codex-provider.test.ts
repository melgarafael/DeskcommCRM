import { describe, expect, it } from "vitest";

import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { ehProvedorSuportado, PROVEDORES_COM_CHAVE_MANUAL } from "@/lib/ai/pontos/provedores";

describe("provider openai-codex", () => {
  it("oferecido na tela e executável no registry", () => {
    expect(ehProvedorSuportado("openai-codex")).toBe(true);
    expect(createDefaultRegistry()["openai-codex"]).toBeTypeOf("function");
  });

  it("NÃO aceita chave colada (assinatura se conecta via OAuth)", () => {
    const ids = PROVEDORES_COM_CHAVE_MANUAL.map((p) => p.id);
    expect(ids).not.toContain("openai-codex");
    expect(ids.sort()).toEqual(["anthropic", "google", "openai", "openrouter"]);
  });
});
