import { describe, expect, it } from "vitest";

import { opcoesDoPreparo } from "./opcoes-do-preparo";

describe("opcoesDoPreparo", () => {
  it("chave ausente (campanha antiga) = tudo ligado", () => {
    expect(opcoesDoPreparo({ niche: "x" })).toEqual({ avaliarSite: true, gerarPrevia: true });
    expect(opcoesDoPreparo(null)).toEqual({ avaliarSite: true, gerarPrevia: true });
    expect(opcoesDoPreparo(undefined)).toEqual({ avaliarSite: true, gerarPrevia: true });
  });
  it("só false explícito desliga", () => {
    expect(opcoesDoPreparo({ gerar_previa: false })).toEqual({ avaliarSite: true, gerarPrevia: false });
    expect(opcoesDoPreparo({ avaliar_site: false })).toEqual({ avaliarSite: false, gerarPrevia: false });
    expect(opcoesDoPreparo({ avaliar_site: "false" })).toEqual({ avaliarSite: true, gerarPrevia: true });
  });
  it("a prévia depende da avaliação", () => {
    expect(opcoesDoPreparo({ avaliar_site: false, gerar_previa: true }).gerarPrevia).toBe(false);
  });
});
