import { describe, expect, it } from "vitest";

import {
  DEFAULT_THRESHOLD_MINUTES,
  MAX_THRESHOLD_MINUTES,
  MIN_THRESHOLD_MINUTES,
  gapQualificaRetorno,
  limiarDaTela,
  limiarValido,
  minutosDoLimiar,
  segmentoCasa,
} from "./gap-de-retorno";

const AGORA = new Date("2026-09-20T12:00:00.000Z");

function ha(minutos: number): Date {
  return new Date(AGORA.getTime() - minutos * 60_000);
}

describe("minutosDoLimiar / limiarDaTela", () => {
  it("1 dia é o padrão gravado", () => {
    expect(minutosDoLimiar(1, "days")).toBe(DEFAULT_THRESHOLD_MINUTES);
    expect(DEFAULT_THRESHOLD_MINUTES).toBe(1440);
  });

  it("90 dias é o teto, 1 hora é o piso", () => {
    expect(minutosDoLimiar(90, "days")).toBe(MAX_THRESHOLD_MINUTES);
    expect(minutosDoLimiar(1, "hours")).toBe(MIN_THRESHOLD_MINUTES);
    expect(limiarValido(MAX_THRESHOLD_MINUTES)).toBe(true);
    expect(limiarValido(MIN_THRESHOLD_MINUTES)).toBe(true);
    expect(limiarValido(MIN_THRESHOLD_MINUTES - 1)).toBe(false);
    expect(limiarValido(MAX_THRESHOLD_MINUTES + 1)).toBe(false);
  });

  it("a tela reconstrói a maior unidade inteira", () => {
    expect(limiarDaTela(1440)).toEqual({ valor: 1, unidade: "days" });
    expect(limiarDaTela(2880)).toEqual({ valor: 2, unidade: "days" });
    expect(limiarDaTela(120)).toEqual({ valor: 2, unidade: "hours" });
    expect(limiarDaTela(90)).toEqual({ valor: 90, unidade: "minutes" });
  });

  it("ida e volta não inventa minuto", () => {
    for (const minutes of [60, 90, 1440, 10_080, MAX_THRESHOLD_MINUTES]) {
      const tela = limiarDaTela(minutes);
      expect(minutosDoLimiar(tela.valor, tela.unidade)).toBe(minutes);
    }
  });
});

describe("gapQualificaRetorno", () => {
  it("primeiro inbound da vida não é retorno", () => {
    expect(gapQualificaRetorno(null, AGORA, 1440)).toBe(false);
  });

  it("1 minuto abaixo do limiar não dispara; no limiar dispara", () => {
    expect(gapQualificaRetorno(ha(1439), AGORA, 1440)).toBe(false);
    expect(gapQualificaRetorno(ha(1440), AGORA, 1440)).toBe(true);
    expect(gapQualificaRetorno(ha(1441), AGORA, 1440)).toBe(true);
  });

  it("rajada de minutos não é retorno mesmo com limiar no piso", () => {
    expect(gapQualificaRetorno(ha(8), AGORA, 60)).toBe(false);
    expect(gapQualificaRetorno(ha(60), AGORA, 60)).toBe(true);
  });

  it("limiar fora da faixa não dispara — não é atalho para ignorar o teto", () => {
    expect(gapQualificaRetorno(ha(10), AGORA, 5)).toBe(false);
    expect(gapQualificaRetorno(ha(MAX_THRESHOLD_MINUTES + 10), AGORA, MAX_THRESHOLD_MINUTES + 1)).toBe(
      false,
    );
  });
});

describe("segmentoCasa", () => {
  it("sem segmento = todo mundo; um tag em comum basta", () => {
    expect(segmentoCasa([], ["vip"])).toBe(true);
    expect(segmentoCasa(["vip"], ["vip", "novo"])).toBe(true);
    expect(segmentoCasa(["vip"], ["novo"])).toBe(false);
  });
});
