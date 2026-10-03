/**
 * A CAUDA DO LAÇO DE TOOLS VAI PARA O CACHE — só Anthropic, só quando há laço.
 *
 * Medido numa instalação real (27/09/2026): cada resposta do agente tem ~3,5
 * passos, e a abertura + os resultados dos passos anteriores (~12 mil tokens)
 * eram reenviados a preço cheio em todo passo — 46% do custo da resposta. O
 * `cache_control` no nível do pedido faz o passo seguinte ler do cache.
 *
 * O que NÃO prova: o efeito na conta do provedor (mede-se em produção, vendo
 * `llm_calls.cache_read_tokens` subir), nem que o provedor aceite o campo — a
 * conversão `providerOptions.anthropic.cacheControl` → `cache_control` na raiz do
 * pedido é do `@ai-sdk/anthropic` (dist/index.js, `cache_control: anthropicOptions.cacheControl`).
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { cacheDaCauda } from "@/lib/agent-engine/edge/llm/run-model-call";

describe("cacheDaCauda", () => {
  it("⭐ Anthropic com laço de tools: breakpoint de 5 min no fim da conversa", () => {
    expect(cacheDaCauda("anthropic", 10)).toEqual({
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } } },
    });
  });

  it("um passo só não ganha cache: escrever sem reler só encarece", () => {
    expect(cacheDaCauda("anthropic", 1)).toEqual({});
    expect(cacheDaCauda("anthropic", undefined)).toEqual({});
  });

  it("outro provedor não recebe a opção", () => {
    expect(cacheDaCauda("openai", 10)).toEqual({});
  });

  it("a chamada do motor usa a regra", () => {
    const fonte = readFileSync("lib/agent-engine/edge/llm/run-model-call.ts", "utf8");
    expect(fonte).toContain("...cacheDaCauda(config.provider, input.maxSteps),");
  });
});
