import { describe, expect, it } from "vitest";

import { alvoDeVolta } from "./update-force";

/**
 * A derivação do alvo da força (#2756). O que está sob prova aqui é a TAG; a
 * ponta que monta a frase a partir dela (`comandoDeVolta`, na tela) tem o seu
 * próprio teste de espelho em UpdatePanel.test.tsx.
 */
describe("alvoDeVolta", () => {
  it("versão da tela (sem o v) vira tag de release", () => {
    expect(alvoDeVolta("1.0.0")).toBe("v1.0.0");
  });

  it("versão que já veio com v não ganha dois", () => {
    expect(alvoDeVolta("v1.0.0")).toBe("v1.0.0");
  });

  it("sufixo de release entra na tag como está — é o mesmo nome no git", () => {
    expect(alvoDeVolta("1.2.3-rc.1")).toBe("v1.2.3-rc.1");
  });

  it("marca de desenvolvimento não tem imagem publicada: sem alvo, só --force", () => {
    expect(alvoDeVolta("abc1234")).toBe("");
    expect(alvoDeVolta("abc1234-dirty")).toBe("");
  });

  it("ausente é sem alvo — o host resolve e recusa em português o que não der", () => {
    expect(alvoDeVolta(undefined)).toBe("");
    expect(alvoDeVolta("")).toBe("");
  });
});
