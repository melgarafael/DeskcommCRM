import { describe, expect, it } from "vitest";
import { configuracaoPadrao } from "./exemplos";
import { dentroDaJanela } from "./janela";
describe("janela no fuso da cadência", () => {
  it("respeita abertura inclusiva e fechamento exclusivo em São Paulo", () => {
    const c = configuracaoPadrao();
    expect(dentroDaJanela(c, new Date("2026-10-26T10:59:00Z"))).toBe(false);
    expect(dentroDaJanela(c, new Date("2026-10-26T11:00:00Z"))).toBe(true);
    expect(dentroDaJanela(c, new Date("2026-10-26T21:00:00Z"))).toBe(false);
  });
  it("não envia no dia desmarcado nem num fuso inválido", () => {
    const c = configuracaoPadrao();
    expect(dentroDaJanela(c, new Date("2026-10-25T15:00:00Z"))).toBe(false);
    expect(dentroDaJanela({ ...c, fuso: "invalido" }, new Date())).toBe(false);
  });
});
