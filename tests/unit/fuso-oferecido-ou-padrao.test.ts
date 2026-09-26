/**
 * O FUSO INICIAL DE UM FORMULÁRIO COM LISTA FECHADA.
 *
 * O cadastro de horário do atendente é um <select> com `FUSOS_OFERECIDOS`. Se o
 * fuso sugerido não estiver na lista, o <select> não tem <option> para ele e a
 * tela mostra outro fuso enquanto o estado guarda o sugerido. Por isso o inicial
 * é o da organização SÓ quando ela está entre as opções.
 */
import { describe, expect, it } from "vitest";

import { FUSO_PADRAO, FUSOS_OFERECIDOS, fusoOferecidoOuPadrao } from "@/lib/tempo/fusos";

describe("fusoOferecidoOuPadrao", () => {
  it("usa o fuso da organização quando ele está entre os oferecidos", () => {
    expect(FUSOS_OFERECIDOS.map((f) => f.codigo)).toContain("America/Mexico_City");
    expect(fusoOferecidoOuPadrao("America/Mexico_City")).toBe("America/Mexico_City");
    expect(fusoOferecidoOuPadrao("  Europe/Lisbon ")).toBe("Europe/Lisbon");
  });

  it("um fuso válido que não está na lista cai no padrão, para o <select> não mostrar outro", () => {
    expect(fusoOferecidoOuPadrao("America/Chihuahua")).toBe(FUSO_PADRAO);
  });

  it("sem fuso, ou com texto que não é fuso, cai no padrão", () => {
    for (const ruim of [undefined, null, "", "   ", "America/Asunción", "Marte/Olympus"]) {
      expect(fusoOferecidoOuPadrao(ruim)).toBe(FUSO_PADRAO);
    }
  });
});
