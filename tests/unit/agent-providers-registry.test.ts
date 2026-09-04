import { describe, expect, it } from "vitest";

import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";

describe("createDefaultRegistry", () => {
  it("registra os providers que a tela oferece", () => {
    // Eram três até a migration 0127 abrir `provider` como vocabulário aberto e
    // a OpenRouter entrar; depois vieram NVIDIA/Ollama/DeepSeek/Qwen/Zhipu/
    // Moonshot. A lista fica travada aqui de propósito: provider novo no
    // registry sem entrada em `lib/ai/pontos/provedores.ts` é código que
    // ninguém alcança pela tela, e o inverso é uma tela que oferece o que
    // toda chamada recusaria. O par é vigiado por provedores-x-registry.test.ts.
    const reg = createDefaultRegistry();
    expect(Object.keys(reg).sort()).toEqual([
      "anthropic",
      "deepseek",
      "google",
      "moonshot",
      "nvidia",
      "ollama",
      "openai",
      "openrouter",
      "qwen",
      "zhipu",
    ]);
  });
  it("cada factory produz um LanguageModel (não lança ao instanciar)", () => {
    const reg = createDefaultRegistry();
    expect(() => reg.anthropic!("k", "claude-sonnet-4-6")).not.toThrow();
    expect(() => reg.openai!("k", "gpt-5")).not.toThrow();
    expect(() => reg.google!("k", "gemini-2.5-pro")).not.toThrow();
    expect(() => reg.openrouter!("k", "meta-llama/llama-3.3-70b-instruct")).not.toThrow();
    // Endpoint próprio (gateway compatível, ou modelo local no roteiro).
    expect(() => reg.openrouter!("k", "x/y", "https://gateway.exemplo/v1")).not.toThrow();
    expect(() => reg.nvidia!("k", "meta/llama-3.1-70b-instruct")).not.toThrow();
    expect(() => reg.ollama!("", "llama3.1")).not.toThrow();
    expect(() => reg.deepseek!("k", "deepseek-chat")).not.toThrow();
    expect(() => reg.qwen!("k", "qwen-plus")).not.toThrow();
    expect(() => reg.zhipu!("k", "glm-4.6")).not.toThrow();
    expect(() => reg.moonshot!("k", "moonshot-v1-8k")).not.toThrow();
  });
});
