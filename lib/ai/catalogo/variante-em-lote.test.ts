import { describe, expect, it } from "vitest";

import { ehVarianteEmLote } from "./variante-em-lote";

describe("ehVarianteEmLote — o id que o endpoint de chat recusa", () => {
  it("reconhece o sufixo :batch", () => {
    expect(ehVarianteEmLote("openai/gpt-6-luna:batch")).toBe(true);
    expect(ehVarianteEmLote("deepseek/deepseek-v4.1-flash:batch")).toBe(true);
  });

  it("ignora caixa e espaço nas pontas", () => {
    expect(ehVarianteEmLote("  openai/gpt-6-luna:BATCH ")).toBe(true);
  });

  it("não confunde o modelo de chat da mesma família", () => {
    expect(ehVarianteEmLote("openai/gpt-6-luna")).toBe(false);
    expect(ehVarianteEmLote("deepseek/deepseek-v4.1-flash")).toBe(false);
  });

  it("só vale no FIM do id — 'batch' no meio do nome é outro modelo", () => {
    expect(ehVarianteEmLote("acme/batch-chat-1")).toBe(false);
    expect(ehVarianteEmLote("acme/modelo:batch-extra")).toBe(false);
  });

  it("outros sufixos da OpenRouter continuam valendo", () => {
    expect(ehVarianteEmLote("meta-llama/llama-3.1-8b-instruct:free")).toBe(false);
    expect(ehVarianteEmLote("openai/gpt-6-luna-pro")).toBe(false);
  });

  it("vazio e ausente não são lote", () => {
    expect(ehVarianteEmLote("")).toBe(false);
    expect(ehVarianteEmLote(null)).toBe(false);
    expect(ehVarianteEmLote(undefined)).toBe(false);
  });
});
