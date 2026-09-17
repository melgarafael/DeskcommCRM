import { describe, expect, it } from "vitest";

import { detectarMuletaMecanica } from "./anti-mecanico";

describe("detectarMuletaMecanica", () => {
  it("pega a costura de retomada que o dono citou", () => {
    expect(detectarMuletaMecanica("Como estamos falando disso, vamos continuar")).toBe(
      "como estamos falando",
    );
  });

  it("pega variações de retomada explícita", () => {
    expect(detectarMuletaMecanica("Conforme conversamos antes, o senhor prefere…")).toBe(
      "conforme conversamos",
    );
    expect(detectarMuletaMecanica("Voltando ao assunto da moto, qual o ano?")).toBe(
      "voltando ao assunto",
    );
    expect(detectarMuletaMecanica("Retomando nossa conversa, podemos seguir?")).toBe(
      "retomando o assunto",
    );
  });

  it("NÃO veta fala natural que só menciona o contexto", () => {
    expect(detectarMuletaMecanica("Sobre a moto, qual o ano dela?")).toBeNull();
    expect(detectarMuletaMecanica("Então, me diz a sua cidade")).toBeNull();
    expect(detectarMuletaMecanica("Perfeito! Qual o seu nome completo?")).toBeNull();
  });
});
