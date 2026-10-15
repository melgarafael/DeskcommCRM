import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { costCents, precoDoModelo, type TokenUsage } from "./pricing";

/**
 * O defeito de origem, medido numa VPS real: o agente atende em
 * `claude-sonnet-5` (o padrão do catálogo desde a migration 0101) e a tabela de
 * preços parou na geração 4. Resultado: `cost_cents` NULL em toda chamada, tela
 * Uso e orçamento em zero e teto mensal que nunca dispara — porque o budget soma
 * `coalesce(cost_cents, 0)`.
 *
 * Os dois irmãos do mesmo defeito, ambos do antigo match por `startsWith`:
 *   · `claude-opus-4` casava com `claude-opus-4-8` e cobrava US$ 15/75 (preço do
 *     Opus 4/4.1, aposentados) por um modelo de US$ 5/25 — sinal invertido: teto
 *     disparando cedo demais;
 *   · qualquer id FUTURO que apenas começasse igual (`claude-sonnet-50`) ganharia
 *     preço de outro modelo, e custo errado não-nulo é pior que custo nulo —
 *     não acende o sinal de gasto incompleto.
 *
 * Preços conferidos em 2026-09 em platform.claude.com/docs/en/about-claude/pricing.
 */

const NADA: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * Virada do preço promocional do Gemini 3.6/3.7/3.8 Flash.
 * UTC: a página do Google diz "January 1, 2027" sem fuso, e o repo grava
 * instante em ISO-8601 UTC. O instante é inclusivo do lado novo.
 */
const ANTES_DA_VIRADA = new Date("2026-12-31T23:59:59.999Z");
const VIRADA_2027 = new Date("2027-01-01T00:00:00.000Z");

/** 1 MTok só de entrada (sem cache) → cents. Isola a tarifa de entrada. */
function entrada(model: string, em?: Date): number | null {
  return costCents(model, { ...NADA, inputTokens: 1_000_000 }, "1h", em);
}

/** 1 MTok só de saída → cents. Isola a tarifa de saída. */
function saida(model: string, em?: Date): number | null {
  return costCents(model, { ...NADA, outputTokens: 1_000_000 }, "1h", em);
}

/** 1 MTok inteiro lido do cache → cents. */
function leituraDeCache(model: string, em?: Date): number | null {
  return costCents(model, { ...NADA, inputTokens: 1_000_000, cacheReadTokens: 1_000_000 }, "1h", em);
}

/** 1 MTok gravado no cache, no TTL pedido → cents. */
function gravacaoDeCache(model: string, ttl: "5m" | "1h", em?: Date): number | null {
  return costCents(model, { ...NADA, inputTokens: 1_000_000, cacheWriteTokens: 1_000_000 }, ttl, em);
}

describe("costCents — cada tarifa isolada, por modelo", () => {
  // Entrada e saída medidas SEPARADAMENTE de propósito: somadas, uma troca
  // acidental de 5/25 por 25/5 daria os mesmos US$ 30 e passaria verde.
  it.each([
    // modelo,              entrada, saída, leitura de cache, gravação 5m, gravação 1h
    // Família 5.5 (conferida em 11/10/2026): leitura de cache a 0.05× no Sonnet e no Opus.
    ["claude-haiku-5-5", 10, 50, 1, 12.5, 20],
    ["claude-sonnet-5-5", 200, 1000, 10, 250, 400],
    ["claude-opus-5-5", 400, 2000, 20, 500, 800],
    ["claude-sonnet-5", 200, 1000, 20, 250, 400],
    ["claude-sonnet-4-6", 300, 1500, 30, 375, 600],
    ["claude-haiku-4-5", 100, 500, 10, 125, 200],
    ["claude-opus-5", 500, 2500, 50, 625, 1000],
    ["claude-opus-4-8", 500, 2500, 50, 625, 1000],
    ["claude-opus-4-7", 500, 2500, 50, 625, 1000],
    ["claude-opus-4-6", 500, 2500, 50, 625, 1000],
    ["claude-opus-4-5", 500, 2500, 50, 625, 1000],
    // Aposentados, e 3× mais caros que o Opus 4.5 — é o par que o prefixo confundia.
    ["claude-opus-4-1", 1500, 7500, 150, 1875, 3000],
    ["claude-opus-4", 1500, 7500, 150, 1875, 3000],
    // OpenAI — gpt-4o, gpt-4o-mini e linha 5.x do catálogo (issue #1478)
    ["gpt-4o-mini", 15, 60, 7.5, 15, 15],
    ["gpt-4o", 250, 1000, 125, 250, 250],
    ["gpt-4o-2024-05-13", 500, 1500, 500, 500, 500],
    // Linha 6 (conferida em 11/10/2026): leitura de cache a 0.05× só no gpt-6.1-sol.
    ["gpt-6-astra", 1000, 5000, 100, 1250, 1250],
    ["gpt-6.1-sol", 200, 1000, 10, 250, 250],
    ["gpt-6-luna", 10, 50, 1, 12.5, 12.5],
    ["gpt-5.6-terra", 200, 1200, 20, 250, 250],
    ["gpt-5.6-sol", 400, 2000, 40, 500, 500],
    ["gpt-5.6-luna", 20, 120, 2, 25, 25],
    ["gpt-5.5", 500, 3000, 50, 500, 500],
    ["gpt-5.5-pro", 3000, 18000, 3000, 3000, 3000],
    ["gpt-5.4", 250, 1500, 25, 250, 250],
    ["gpt-5.4-mini", 75, 450, 7.5, 75, 75],
    ["gpt-5.4-nano", 20, 125, 2, 20, 20],
    ["gpt-5.4-pro", 3000, 18000, 3000, 3000, 3000],
    // Google — leitura de cache a 0.1× a entrada (2.0 Flash não tem cache implícito, ver pricing.ts).
    // 3.6/3.7/3.8 Flash têm virada em 2027-01-01T00:00:00Z; os casos datados ficam no describe abaixo.
    ["gemini-3.1-flash-lite", 25, 150, 2.5, 25, 25],
    ["gemini-3.5-flash", 150, 900, 15, 150, 150],
    ["gemini-3.5-flash-lite", 30, 250, 3, 30, 30],
    ["gemini-3.1-pro-preview", 200, 1200, 20, 200, 200],
    ["gemini-2.5-pro", 125, 1000, 12.5, 125, 125],
    ["gemini-2.5-flash", 30, 250, 3, 30, 30],
    ["gemini-2.5-flash-lite", 10, 40, 1, 10, 10],
    ["gemini-2.0-flash", 10, 40, 10, 10, 10],
  ])("%s", (model, cIn, cOut, cLeitura, cGrav5m, cGrav1h) => {
    expect(entrada(model)).toBeCloseTo(cIn, 6);
    expect(saida(model)).toBeCloseTo(cOut, 6);
    expect(leituraDeCache(model)).toBeCloseTo(cLeitura, 6);
    expect(gravacaoDeCache(model, "5m")).toBeCloseTo(cGrav5m, 6);
    expect(gravacaoDeCache(model, "1h")).toBeCloseTo(cGrav1h, 6);
  });
});

describe("Gemini 3.6/3.7/3.8 Flash — a promo acaba em 2027-01-01T00:00:00Z", () => {
  // Página ai.google.dev/gemini-api/docs/pricing, lida em 2026-10-12 (Standard):
  // até 31/12/2026 entrada 0,75 / saída 3,75 / leitura de cache 0,075;
  // a partir de 01/01/2027, 1,50 / 7,50 / 0,15. Gravação segue a entrada
  // (o motor não usa cache explícito; a linha existe para não ficar stale).
  const MODELOS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"] as const;

  it.each(MODELOS)("%s cobra a promo no instante anterior à virada", (model) => {
    expect(entrada(model, ANTES_DA_VIRADA)).toBeCloseTo(75, 6);
    expect(saida(model, ANTES_DA_VIRADA)).toBeCloseTo(375, 6);
    expect(leituraDeCache(model, ANTES_DA_VIRADA)).toBeCloseTo(7.5, 6);
    expect(gravacaoDeCache(model, "5m", ANTES_DA_VIRADA)).toBeCloseTo(75, 6);
    expect(gravacaoDeCache(model, "1h", ANTES_DA_VIRADA)).toBeCloseTo(75, 6);
  });

  it.each(MODELOS)("%s cobra 1,50/7,50/0,15 a partir de 2027-01-01T00:00:00Z", (model) => {
    expect(entrada(model, VIRADA_2027)).toBeCloseTo(150, 6);
    expect(saida(model, VIRADA_2027)).toBeCloseTo(750, 6);
    expect(leituraDeCache(model, VIRADA_2027)).toBeCloseTo(15, 6);
    expect(gravacaoDeCache(model, "5m", VIRADA_2027)).toBeCloseTo(150, 6);
    expect(gravacaoDeCache(model, "1h", VIRADA_2027)).toBeCloseTo(150, 6);
  });

  it("o prefixo google/ do OpenRouter acompanha a virada", () => {
    expect(entrada("google/gemini-3.8-flash", ANTES_DA_VIRADA)).toBeCloseTo(75, 6);
    expect(entrada("google/gemini-3.8-flash", VIRADA_2027)).toBeCloseTo(150, 6);
    expect(saida("google/gemini-3.6-flash", VIRADA_2027)).toBeCloseTo(750, 6);
    expect(leituraDeCache("google/gemini-3.7-flash", VIRADA_2027)).toBeCloseTo(15, 6);
    expect(entrada("google/gemini-3.8-flash-20270101", VIRADA_2027)).toBeCloseTo(150, 6);
    expect(entrada("gemini-3.6-flash-20261231", ANTES_DA_VIRADA)).toBeCloseTo(75, 6);
  });

  it("um Gemini sem promoção não muda de preço na virada", () => {
    expect(entrada("gemini-3.5-flash", ANTES_DA_VIRADA)).toBeCloseTo(150, 6);
    expect(entrada("gemini-3.5-flash", VIRADA_2027)).toBeCloseTo(150, 6);
    expect(entrada("gemini-3.1-flash-lite", VIRADA_2027)).toBeCloseTo(25, 6);
  });
});

describe("costCents — o TTL do cache é o que o knob LLM_CACHE_TTL diz", () => {
  it("gravação em 5m custa 1,25× a entrada, não 2×", () => {
    // O defeito: a tabela só tinha a tarifa de 1h e o cálculo a aplicava sempre.
    // Com LLM_CACHE_TTL='5m' (valor aceito por lib/agent-engine/env.ts), isso
    // superfaturava a parcela de gravação em 60%.
    expect(gravacaoDeCache("claude-sonnet-5", "5m")).toBeCloseTo(250, 6);
    expect(gravacaoDeCache("claude-sonnet-5", "1h")).toBeCloseTo(400, 6);
  });

  it("sem TTL informado, vale a doutrina do repo: 1h", () => {
    const comGravacao: TokenUsage = { ...NADA, inputTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
    expect(costCents("claude-sonnet-5", comGravacao)).toBeCloseTo(400, 6);
  });
});

describe("costCents — id que a tabela não conhece volta NULL", () => {
  it.each([
    ["gpt-desconhecido-9"],
    ["claude-inexistente-9"],
    [""],
    // O caso que o `startsWith` deixava passar: começa igual a um id conhecido,
    // mas é outro modelo. Custo errado não-nulo não acende gasto incompleto.
    ["claude-sonnet-50"],
    ["claude-opus-4-9"],
    ["claude-opus-48"],
    // Vizinhos da família 5.5: nenhum herda o preço do Haiku 5.5 (20× mais barato
    // que o Opus 5), nem o Haiku 5.5 o de outro.
    ["claude-haiku-5"],
    ["claude-haiku-5-50"],
    ["claude-haiku-5-5-1"],
    ["claude-haiku-55"],
    // Vizinhos da linha 6: o gpt-6-sol ficou fora do catálogo (o 6.1 o sucede) e
    // não herda o preço de ninguém; nem o gpt-6-luna empresta o seu a um id parecido.
    ["gpt-6-sol"],
    ["gpt-6"],
    ["gpt-6.1-luna"],
    ["gpt-6-luna-mini"],
    // Mesmo com o recorte do prefixo tolerado, modelo que não casa em NENHUM
    // formato continua NULL — o recorte não inventa preço (armadilha 3).
    ["anthropic/claude-sonnet-50"],
    ["anthropic/claude-opus-4-9"],
    // Prefixo de provider com PONTO (formato Bedrock) não é o que este seam
    // registra em llm_calls — e vale NULL, não um chute. A barra (`anthropic/…`,
    // OpenRouter) já é tolerada e coberta nos testes do PR #1880.
    ["anthropic.claude-sonnet-5"],
  ])("%s → null", (model) => {
    expect(costCents(model, { ...NADA, inputTokens: 1_000_000 })).toBeNull();
    expect(precoDoModelo(model)).toBeUndefined();
  });
});

describe("costCents — id com prefixo provider/ (formato OpenRouter)", () => {
  // Issue #1880: o OpenRouter devolve o id com o prefixo `anthropic/…`, e a
  // tabela de preços é indexada sem ele. Custo NULL em toda chamada do agente →
  // llm_calls.cost_cents nulo → budget soma coalesce(cost_cents, 0) → teto cego.
  it.each([
    // modelo, entrada, saída, leitura de cache, gravação 5m, gravação 1h
    ["anthropic/claude-sonnet-5", 200, 1000, 20, 250, 400],
    ["anthropic/claude-sonnet-4-6", 300, 1500, 30, 375, 600],
    ["anthropic/claude-haiku-4-5", 100, 500, 10, 125, 200],
    ["anthropic/claude-opus-5", 500, 2500, 50, 625, 1000],
    ["anthropic/claude-haiku-5-5", 10, 50, 1, 12.5, 20],
    ["openai/gpt-6-luna", 10, 50, 1, 12.5, 12.5],
    ["google/gemini-3.5-flash-lite", 30, 250, 3, 30, 30],
  ])("%s custa como o id sem prefixo", (model, cIn, cOut, cLeitura, cGrav5m, cGrav1h) => {
    expect(entrada(model)).toBeCloseTo(cIn, 6);
    expect(saida(model)).toBeCloseTo(cOut, 6);
    expect(leituraDeCache(model)).toBeCloseTo(cLeitura, 6);
    expect(gravacaoDeCache(model, "5m")).toBeCloseTo(cGrav5m, 6);
    expect(gravacaoDeCache(model, "1h")).toBeCloseTo(cGrav1h, 6);
  });

  it("sufixo de data do vendor é tolerado mesmo com o prefixo provider/", () => {
    expect(entrada("anthropic/claude-opus-4-1-20250805")).toBeCloseTo(1500, 6);
    expect(entrada("anthropic/claude-sonnet-4-5-20250929")).toBeCloseTo(300, 6);
  });

  it("o TTL do cache continua respeitando o knob com prefixo", () => {
    expect(gravacaoDeCache("anthropic/claude-sonnet-5", "5m")).toBeCloseTo(250, 6);
    expect(gravacaoDeCache("anthropic/claude-sonnet-5", "1h")).toBeCloseTo(400, 6);
  });

  it("a conversa real com prefixo deixa de ser null", () => {
    const turnoReal: TokenUsage = {
      inputTokens: 359_369,
      outputTokens: 4_070,
      cacheReadTokens: 294_128,
      cacheWriteTokens: 0,
    };
    const custo = costCents("anthropic/claude-sonnet-5", turnoReal);
    expect(custo).not.toBeNull();
    expect(custo).toBeGreaterThan(22);
    expect(custo).toBeLessThan(24);
  });
});

describe("costCents — sufixo de data do vendor é tolerado", () => {
  it.each([
    ["claude-opus-4-1-20250805", 1500],
    ["claude-opus-4-20250514", 1500],
    ["claude-sonnet-4-5-20250929", 300],
    ["claude-haiku-4-5-20251001", 100],
    ["gpt-4o-mini-2024-07-18", 15],
    ["gpt-4o-2024-08-06", 250],
  ])("%s custa como o id sem data", (model, cIn) => {
    expect(entrada(model)).toBeCloseTo(cIn, 6);
  });

  it("snapshot com preço próprio não herda o do id sem data (gpt-4o-2024-05-13)", () => {
    expect(entrada("gpt-4o-2024-05-13")).toBeCloseTo(500, 6);
    expect(entrada("gpt-4o-2024-05-13")).not.toBeCloseTo(250, 6);
  });

  it("data mal formada não vira desconto silencioso", () => {
    expect(entrada("claude-opus-4-1-2025")).toBeNull();
    expect(entrada("claude-opus-4-1-202508051")).toBeNull();
  });
});

describe("costCents — a conversa real que originou este PR", () => {
  it("359.369 de entrada com 294.128 vindos do cache, em claude-sonnet-5", () => {
    const turnoReal: TokenUsage = {
      inputTokens: 359_369,
      outputTokens: 4_070,
      cacheReadTokens: 294_128,
      cacheWriteTokens: 0,
    };
    // Entrada não-cacheada: 359.369 − 294.128 = 65.241 tokens.
    const esperado = (((359_369 - 294_128) * 2 + 294_128 * 0.2 + 4_070 * 10) / 1_000_000) * 100;
    expect(costCents("claude-sonnet-5", turnoReal)).toBeCloseTo(esperado, 6);
    // ~23 cents: o número que a tela Uso e orçamento passa a somar, e que antes
    // deste conserto era NULL — zero para o teto mensal.
    expect(costCents("claude-sonnet-5", turnoReal)).toBeGreaterThan(22);
    expect(costCents("claude-sonnet-5", turnoReal)).toBeLessThan(24);
  });

  it("gpt-4o-mini com tokens reais não devolve custo nulo (Anditec / issue #1478)", () => {
    const turnoReal: TokenUsage = {
      inputTokens: 1_200,
      outputTokens: 150,
      cacheReadTokens: 500,
      cacheWriteTokens: 0,
    };
    const custo = costCents("gpt-4o-mini", turnoReal);
    expect(custo).not.toBeNull();
    expect(custo).toBeCloseTo(0.02325, 5);
  });
});

describe("costCents — o Jev cobra só a entrada, em fração de centavo", () => {
  it("1 MTok de entrada custa 4,2 centavos, e a saída é de graça", () => {
    expect(entrada("jev-1.13.0")).toBeCloseTo(4.2, 10);
    expect(saida("jev-1.13.0")).toBe(0);
  });

  it("uma medição real (388 de entrada, 18 de saída) vale fração, nunca 1 centavo", () => {
    // O caminho do worker arredonda para cima (lib/ai/cost.ts) e transformaria
    // cada decisão em 1 centavo — ~600× o real. Este é o número que vai à coluna.
    const custo = costCents("jev-1.13.0", { ...NADA, inputTokens: 388, outputTokens: 18 });
    expect(custo).toBeCloseTo(0.0016296, 7);
  });

  it("o apelido móvel NÃO herda o preço da versão fixada", () => {
    expect(costCents("jev-latest", { ...NADA, inputTokens: 1_000 })).toBeNull();
  });
});

describe("catálogo — Gemini 3.6/3.7/3.8 Flash fica em 150/750 nas duas tabelas", () => {
  // O apêndice mais tarde vence: o baseline é reaplicado inteiro e o último
  // insert com on conflict é o preço que o self-hoster recebe.
  const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

  function ultimoPrecoDaConta(id: string): { prompt: number; completion: number; notes: string } | undefined {
    const re = new RegExp(`\\('${id}',\\s*(\\d+),\\s*(\\d+),\\s*'([^']*)'`, "g");
    let ultimo: { prompt: number; completion: number; notes: string } | undefined;
    for (const m of baseline.matchAll(re)) {
      ultimo = { prompt: Number(m[1]), completion: Number(m[2]), notes: m[3]! };
    }
    return ultimo;
  }

  function ultimoPrecoDaTela(id: string): { entrada: number; saida: number } | undefined {
    const re = new RegExp(`'${id}'[\\s\\S]{0,500}?(\\d+),\\s*(\\d+),\\s*true\\)`, "g");
    let ultimo: { entrada: number; saida: number } | undefined;
    for (const m of baseline.matchAll(re)) {
      ultimo = { entrada: Number(m[1]), saida: Number(m[2]) };
    }
    return ultimo;
  }

  it.each(["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash"])(
    "%s está a 150/750 no catálogo e na conta, com notes de catálogo",
    (id) => {
      const tela = ultimoPrecoDaTela(id);
      const conta = ultimoPrecoDaConta(id);
      expect(tela, `${id} sem preço em ai_models`).toEqual({ entrada: 150, saida: 750 });
      expect(conta?.prompt, `${id} entrada em ai_pricing`).toBe(150);
      expect(conta?.completion, `${id} saída em ai_pricing`).toBe(750);
      expect(conta?.notes.startsWith("catálogo"), `${id} notes=${conta?.notes}`).toBe(true);
      expect(tela?.entrada).toBe(conta?.prompt);
      expect(tela?.saida).toBe(conta?.completion);
    },
  );
});
