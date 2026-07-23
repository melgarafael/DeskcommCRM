import { describe, expect, it } from "vitest";

import { modelCapabilities } from "@/lib/agent-engine/edge/llm/capabilities";

describe("modelCapabilities", () => {
  it("providers conhecidos aceitam imagem e pdf nativos", () => {
    expect(modelCapabilities("anthropic", "claude-sonnet-4-6")).toEqual({ image: true, pdf: true });
    expect(modelCapabilities("openai", "gpt-5")).toEqual({ image: true, pdf: true });
    expect(modelCapabilities("google", "gemini-2.5-pro")).toEqual({ image: true, pdf: true });
  });
  it("provider DESCONHECIDO cai no default conservador (só derivado)", () => {
    expect(modelCapabilities("novissima-ia", "modelo-x")).toEqual({ image: false, pdf: false });
  });
  it("modelo explicitamente text-only rebaixa mesmo em provider conhecido", () => {
    // um modelo de embeddings/text-only não deve receber imagem nativa
    expect(modelCapabilities("openai", "text-embedding-3-large")).toEqual({ image: false, pdf: false });
  });
});
