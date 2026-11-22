/**
 * A TABELA DO GOOGLE NO CÓDIGO CONTRA A PÁGINA OFICIAL, MODELO POR MODELO.
 *
 * Medição de 18/11/2026, tabela Standard, USD por milhão de tokens:
 *   preços ....... https://aistudio.google.com/docs/pricing
 *   aposentados .. https://aistudio.google.com/docs/deprecations
 *
 * O número que este arquivo existe para prender é o do `gemini-3.5-flash`, que
 * é o DEFAULT do Google no catálogo (`ai_models`, migration 0101) — logo, o
 * modelo que toda instalação Google cobra. A página de preços não tem mais seção
 * dele: o endpoint foi aposentado em 19/05/2026 e "automatically routes API
 * requests to gemini-3.6-flash" (deprecations). Quem paga a conta é o 3.6 Flash,
 * então a tarifa é a do 3.6: 0,75/3,75 até 31/12/2026, 1,50/7,50 a partir de
 * 01/01/2027. A tabela dizia 1,50/9,00 — entrada 2× e saída 2,4× o faturado, em
 * todo turno de toda instalação Google.
 *
 * Três regras que o arquivo também prende:
 *   1. modelo aposentado NÃO sai da tabela (decisão do #4965): preço ausente vira
 *      custo NULL calado na #3013. A fixture inclui os aposentados de propósito;
 *   2. roteamento manda no preço: id aposentado cujo endpoint ainda responde é
 *      faturado na tarifa do destino (3.5 → 3.6, 3.7 → 3.8), e o corte da promo
 *      é o do destino;
 *   3. só o Google está aqui. Preço de outro provedor tem o seu próprio arquivo.
 */
import { describe, expect, it } from "vitest";

import { costCents, precoDoModelo, type TokenUsage } from "@/lib/agent-engine/edge/llm/pricing";

/** Instante da conferência: dentro da promo dos Flash, antes da virada do Argon. */
const EM = new Date("2026-11-18T12:00:00.000Z");
const VIRADA_2027 = new Date("2027-01-01T00:00:00.000Z");

const NADA: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** 1 MTok só de entrada → cents. */
function entrada(model: string, em: Date): number | null {
  return costCents(model, { ...NADA, inputTokens: 1_000_000 }, "1h", em);
}

/** 1 MTok só de saída → cents. */
function saida(model: string, em: Date): number | null {
  return costCents(model, { ...NADA, outputTokens: 1_000_000 }, "1h", em);
}

/** 1 MTok inteiro lido do cache → cents. */
function leitura(model: string, em: Date): number | null {
  return costCents(model, { ...NADA, inputTokens: 1_000_000, cacheReadTokens: 1_000_000 }, "1h", em);
}

/**
 * modelo, entrada, saída, leitura de cache (cents por milhão, EM = 18/11/2026),
 * e de onde saiu o número.
 */
const OFICIAL_18_11_2026: ReadonlyArray<readonly [string, number, number, number, string]> = [
  // Standard de aistudio.google.com/docs/pricing.
  ["gemini-3.8-flash", 75, 375, 7.5, "0,75/3,75/0,075 até 31/12/2026; 1,50/7,50/0,15 depois"],
  ["gemini-3.6-flash", 75, 375, 7.5, "idem 3.8 (é o modelo para onde o 3.5 roteia)"],
  ["gemini-3.7-flash", 75, 375, 7.5, "sem seção na página; roteia ao 3.8 (deprecations)"],
  ["gemini-3.5-flash", 75, 375, 7.5, "sem seção; aposentado 19/05/2026, roteia ao 3.6 (deprecations)"],
  ["gemini-4-argon", 200, 1000, 10, "2/10/0,10 até 30/11/2026; 4/20/0,20 depois"],
  ["gemini-3.5-flash-lite", 30, 250, 3, "0,30/2,50/0,03 (sem faixa acima de 200k)"],
  ["gemini-3.1-flash-lite", 25, 150, 2.5, "0,25/1,50/0,025 — texto/imagem/vídeo"],
  ["gemini-3.1-pro-preview", 200, 1200, 20, "2/12/0,20 até 200k tokens de entrada"],
  // Aposentados com preço preservado (#4965); 404 medido em 18/11/2026.
  ["gemini-2.5-pro", 125, 1000, 12.5, "1,25/10/0,125 até 200k; 404 desde 18/11/2026"],
  ["gemini-2.5-flash", 30, 250, 3, "0,30/2,50/0,03; 404 desde 18/11/2026"],
  ["gemini-2.5-flash-lite", 10, 40, 1, "0,10/0,40/0,01; 404 desde 18/11/2026"],
  ["gemini-2.0-flash", 10, 40, 10, "fora da página; último preço conhecido (0,10/0,40)"],
];

describe("Google — o código cobra o que a página oficial diz (conferido em 2026-11-18)", () => {
  it.each(OFICIAL_18_11_2026)(
    "%s → %s/%s entrada/saída, cache %s (fonte: %s)",
    (model, cIn, cOut, cLeitura) => {
      expect(entrada(model, EM)).toBeCloseTo(cIn, 6);
      expect(saida(model, EM)).toBeCloseTo(cOut, 6);
      expect(leitura(model, EM)).toBeCloseTo(cLeitura, 6);
    },
  );

  it("nenhum id da conferência fica sem preço (custo NULL calado é a #3013)", () => {
    for (const [model] of OFICIAL_18_11_2026) {
      expect(precoDoModelo(model, EM), `${model} sem linha na tabela do motor`).toBeDefined();
    }
  });

  it("o default do Google não volta a 1,50/9,00, preço que a página não tem", () => {
    // O defeito: 9,00 de saída não existe em faixa nenhuma do 3.5/3.6 Flash. Com
    // ele, 1 MTok de saída custava 900 cents contra 375 faturados pelo Google.
    expect(saida("gemini-3.5-flash", EM)).not.toBeCloseTo(900, 6);
    expect(saida("gemini-3.5-flash", EM)).toBeCloseTo(375, 6);
    expect(entrada("gemini-3.5-flash", EM)).not.toBeCloseTo(150, 6);
    expect(entrada("gemini-3.5-flash", EM)).toBeCloseTo(75, 6);
  });

  it("o 3.5 Flash vira junto com o 3.6 na tarifa de 01/01/2027", () => {
    expect(entrada("gemini-3.5-flash", VIRADA_2027)).toBeCloseTo(150, 6);
    expect(saida("gemini-3.5-flash", VIRADA_2027)).toBeCloseTo(750, 6);
    expect(leitura("gemini-3.5-flash", VIRADA_2027)).toBeCloseTo(15, 6);
  });

  it("o prefixo google/ do OpenRouter cobra o mesmo que o id puro", () => {
    expect(entrada("google/gemini-3.5-flash", EM)).toBeCloseTo(75, 6);
    expect(saida("google/gemini-3.5-flash", EM)).toBeCloseTo(375, 6);
  });
});
