import { describe, expect, it } from "vitest";

import {
  ATRASO_MAXIMO_MS,
  ATRASO_MINIMO_MS,
  ATRASO_NOTAR_MS,
  MS_POR_CARACTERE,
  atrasoHumanoEfetivo,
  calcularAtrasoHumano,
} from "@/lib/agent-engine/agent/atraso-humano";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { effectiveKnobs } from "@/lib/ai/pacing-knobs";

/**
 * Issue #653 — o atraso humano antes da 1ª bolha vira knob por conexão.
 *
 * Os quatro números (`atraso_humano` NOTAR/POR_CARACTERE/MINIMO/MAXIMO) eram
 * literais em `atraso-humano.ts`. Agora entram pelo `channel_knobs` (0499), com
 * DEFAULT = os valores de antes: quem nunca configurou tem regressão ZERO, e o
 * leitor (`loadChannelKnobs`/`effectiveKnobs`) preenche os defaults.
 */
describe("atraso humano: default idêntico ao código de antes (regressão zero)", () => {
  it("os defaults do módulo espelham os valores históricos", () => {
    expect(PACING_DEFAULTS.atrasoNotarMs).toBe(ATRASO_NOTAR_MS); // 900
    expect(PACING_DEFAULTS.msPorCaractere).toBe(MS_POR_CARACTERE); // 22
    expect(PACING_DEFAULTS.atrasoMinimoMs).toBe(ATRASO_MINIMO_MS); // 1200
    expect(PACING_DEFAULTS.atrasoMaximoMs).toBe(ATRASO_MAXIMO_MS); // 7500
  });

  it("sem knobs, calcularAtrasoHumano devolve exatamente o histórico (piso e teto)", () => {
    // O mesmo texto curto que o teste antigo prendia: cai no PISO.
    expect(calcularAtrasoHumano("Oi, tudo bem?")).toBe(ATRASO_MINIMO_MS);
    // Parágrafo longo cai no TETO.
    expect(calcularAtrasoHumano("a".repeat(4000))).toBe(ATRASO_MAXIMO_MS);
    // Vazio >= piso.
    expect(calcularAtrasoHumano("")).toBe(ATRASO_MINIMO_MS);
  });

  it("atrasoHumanoEfetivo preenche todos os quatro com o default quando ausente", () => {
    expect(atrasoHumanoEfetivo(undefined)).toEqual({
      atrasoNotarMs: ATRASO_NOTAR_MS,
      msPorCaractere: MS_POR_CARACTERE,
      atrasoMinimoMs: ATRASO_MINIMO_MS,
      atrasoMaximoMs: ATRASO_MAXIMO_MS,
    });
    // default parcial: o não-informado cai no default.
    expect(atrasoHumanoEfetivo({ msPorCaractere: 10 })).toMatchObject({ msPorCaractere: 10 });
    expect(atrasoHumanoEfetivo({ msPorCaractere: 10 }).atrasoNotarMs).toBe(ATRASO_NOTAR_MS);
  });
});

describe("atraso humano: knobs por conexão mudam o resultado", () => {
  it("NOTAR maior empurra o atraso para cima (mesmo texto)", () => {
    const texto = "Temos sim.";
    const base = calcularAtrasoHumano(texto);
    const comNotar = calcularAtrasoHumano(texto, { atrasoNotarMs: base + 500, atrasoMaximoMs: 10_000 });
    expect(comNotar).toBeGreaterThan(base);
  });

  it("POR_CARACTERE maior pentencia em textos maiores", () => {
    const curto = calcularAtrasoHumano("Oi", { msPorCaractere: 50, atrasoMaximoMs: 10_000 });
    const longo = calcularAtrasoHumano("a".repeat(40), { msPorCaractere: 50, atrasoMaximoMs: 10_000 });
    expect(longo).toBeGreaterThan(curto);
  });

  it("teto da conexão é respeitado (não o default 7500)", () => {
    // Texto que no default explodiria no teto de 7500; com teto menor, para nele.
    // bruto = 900 + 22*400 = 9700 (> 7500 nos dois casos).
    expect(calcularAtrasoHumano("a".repeat(400), { atrasoMaximoMs: 3000 })).toBe(3000);
    expect(calcularAtrasoHumano("a".repeat(400))).toBe(ATRASO_MAXIMO_MS);
  });

  it("piso da conexão pode ser menor que o piso padrão sem afrouxar anti-ban", () => {
    // "" só ultrapassa o piso 1200 quando NOTAR > 1200; com NOTAR 50 o bruto
    // (50) fica abaixo do piso 200 da conexão, que o leva para cima.
    expect(
      calcularAtrasoHumano("", { atrasoNotarMs: 50, atrasoMinimoMs: 200, atrasoMaximoMs: 5000 }),
    ).toBe(200);
    // Sem knobs, o "" recai no piso padrão 1200 (regressão zero).
    expect(calcularAtrasoHumano("")).toBe(ATRASO_MINIMO_MS);
  });
});

describe("leitor efetivo: linha de channel_knobs sobre os defaults", () => {
  it("sem linha, effectiveKnobs devolve os defaults", () => {
    const eff = effectiveKnobs(null);
    expect(eff.atrasoNotarMs).toBe(PACING_DEFAULTS.atrasoNotarMs);
    expect(eff.msPorCaractere).toBe(PACING_DEFAULTS.msPorCaractere);
    expect(eff.atrasoMinimoMs).toBe(PACING_DEFAULTS.atrasoMinimoMs);
    expect(eff.atrasoMaximoMs).toBe(PACING_DEFAULTS.atrasoMaximoMs);
  });

  it("com linha, effectiveKnobs devolve o valor da conexão (e null volta ao default)", () => {
    const eff = effectiveKnobs(
      {
        atraso_notar_ms: 1200,
        ms_por_caractere: null,
        atraso_minimo_ms: 1500,
        atraso_maximo_ms: 6000,
      } as never,
    );
    expect(eff.atrasoNotarMs).toBe(1200);
    expect(eff.msPorCaractere).toBe(PACING_DEFAULTS.msPorCaractere); // null -> default
    expect(eff.atrasoMinimoMs).toBe(1500);
    expect(eff.atrasoMaximoMs).toBe(6000);
  });
});