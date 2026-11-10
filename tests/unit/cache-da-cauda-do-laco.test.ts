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

import { ehOpenRouterOficial } from "@/lib/agent-engine/edge/llm/providers";
import {
  cacheDaCauda,
  corpoDaOpenRouterNoResultado,
  haLacoDeFerramentas,
} from "@/lib/agent-engine/edge/llm/run-model-call";

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
    // `cfgUsada` é a config de QUEM responde: a da assinatura, ou a da reserva
    // quando ela assume (#1672). Amarrar à config usada, e não à inicial, é o
    // que mantém a regra certa depois da queda.
    expect(fonte).toContain("...cacheDaCauda(cfgUsada.provider, input.maxSteps),");
  });
});

/**
 * Na OpenRouter, o que decide se um campo próprio dela vai no pedido (cache,
 * sessão) ou se o corpo da resposta é guardado (custo) é UM critério: o endereço
 * da chamada é o host oficial? Gateway do operador nunca recebe nada novo.
 */
describe("OpenRouter oficial e a regra do laço", () => {
  it("ehOpenRouterOficial: o padrão e o host exato passam; gateway, host parecido e lixo, não", () => {
    expect(ehOpenRouterOficial(undefined)).toBe(true);
    expect(ehOpenRouterOficial("https://openrouter.ai/api/v1")).toBe(true);
    expect(ehOpenRouterOficial("https://meu-gateway.exemplo/v1")).toBe(false);
    expect(ehOpenRouterOficial("https://openrouter.ai.exemplo")).toBe(false);
    expect(ehOpenRouterOficial("lixo")).toBe(false);
  });

  it("corpoDaOpenRouterNoResultado: só a OpenRouter oficial guarda o corpo da resposta", () => {
    expect(corpoDaOpenRouterNoResultado("openrouter", undefined)).toEqual({ include: { responseBody: true } });
    expect(corpoDaOpenRouterNoResultado("openrouter", "https://meu-gateway.exemplo/v1")).toEqual({});
    expect(corpoDaOpenRouterNoResultado("openai", undefined)).toEqual({});
  });

  it("haLacoDeFerramentas: um passo, ou sem teto, não é laço", () => {
    expect(haLacoDeFerramentas(1)).toBe(false);
    expect(haLacoDeFerramentas(undefined)).toBe(false);
    expect(haLacoDeFerramentas(2)).toBe(true);
  });
});
