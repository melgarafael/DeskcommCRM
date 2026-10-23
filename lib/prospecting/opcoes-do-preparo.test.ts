import { describe, expect, it } from "vitest";

import { opcoesDoPreparo } from "./opcoes-do-preparo";

describe("opcoesDoPreparo", () => {
  it("chave ausente (campanha antiga): verifica o site, mas NÃO gera prévia (doc 163, B)", () => {
    expect(opcoesDoPreparo({ niche: "x" })).toEqual({ avaliarSite: true, gerarPrevia: false });
    expect(opcoesDoPreparo(null)).toEqual({ avaliarSite: true, gerarPrevia: false });
    expect(opcoesDoPreparo(undefined)).toEqual({ avaliarSite: true, gerarPrevia: false });
  });
  it("busca nova (as duas chaves gravadas) = tudo ligado", () => {
    expect(opcoesDoPreparo({ avaliar_site: true, gerar_previa: true })).toEqual({
      avaliarSite: true,
      gerarPrevia: true,
    });
  });
  it("avaliação: só false explícito desliga; prévia: só true explícito liga", () => {
    expect(opcoesDoPreparo({ gerar_previa: false })).toEqual({ avaliarSite: true, gerarPrevia: false });
    expect(opcoesDoPreparo({ avaliar_site: false })).toEqual({ avaliarSite: false, gerarPrevia: false });
    expect(opcoesDoPreparo({ avaliar_site: "false", gerar_previa: "true" })).toEqual({
      avaliarSite: true,
      gerarPrevia: false,
    });
  });
  it("a prévia depende da avaliação", () => {
    expect(opcoesDoPreparo({ avaliar_site: false, gerar_previa: true }).gerarPrevia).toBe(false);
  });
});
