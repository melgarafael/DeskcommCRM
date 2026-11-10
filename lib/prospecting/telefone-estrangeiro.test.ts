import { describe, expect, it } from "vitest";

import { normalizeProspect } from "@/lib/prospecting/schema";

/**
 * Telefone estrangeiro na Prospecção — issue #3080.
 *
 * O defeito medido pelo autor, em instalação real: três buscas em Portugal
 * (20/20/19 empresas encontradas) terminaram com zero empresas abordáveis,
 * porque `normalizeProspect` descartava todo número que não fosse `+55` — e o
 * telefone original não ficava guardado em lugar nenhum. A busca é paga.
 *
 * O que estes casos fixam:
 *   1. com `+55` e 12 ou 13 dígitos, como antes;
 *   2. sem `+` e com 10 ou 11 dígitos, como antes (prefixa `55`);
 *   3. COM `+` e OUTRO código de país, entre 8 e 15 dígitos (E.164), o número
 *      passa com o `+` na frente — o país está escrito no número, nada é
 *      adivinhado;
 *   4. qualquer outra coisa continua `null`.
 *
 * Tudo pelo caminho real: entrada crua do provedor de Mapas → `normalizeProspect`.
 */
function telefoneDe(raw: string): string | null {
  return normalizeProspect({ title: "Empresa Exemplo", placeId: "p-3080", phone: raw })?.phone ?? null;
}

/** Ramo 1 e 2 — o brasileiro de antes, inteiro. */
describe("brasileiro continua igual (#3080)", () => {
  it("sem código de país: celular (11 dígitos) e fixo (10) ganham o 55", () => {
    expect(telefoneDe("(11) 99999-0000")).toBe("+5511999990000");
    expect(telefoneDe("(11) 3333-4444")).toBe("+551133334444");
  });

  it("já em E.164 com 13 dígitos, e o `55` sem `+` que o provedor às vezes devolve", () => {
    expect(telefoneDe("+55 11 99999-0000")).toBe("+5511999990000");
    expect(telefoneDe("5531999998888")).toBe("+5531999998888");
  });
});

/** Ramo 3 — o conserto. */
describe("estrangeiro com o país escrito no número passa (#3080)", () => {
  it("Portugal, o caso medido pelo autor", () => {
    expect(telefoneDe("+351 912 345 678")).toBe("+351912345678");
  });

  it("outros códigos de país, inclusive com sujeira de formatação e espaço em volta", () => {
    expect(telefoneDe("+1 212 555 1234")).toBe("+12125551234");
    expect(telefoneDe(" +44 20 7946 0958 ")).toBe("+442079460958");
    expect(telefoneDe("+351 (912) 345-678")).toBe("+351912345678");
  });

  it("respeita as bordas do E.164: 8 dígitos passam, 7 e 16 (mais de 15) não", () => {
    expect(telefoneDe("+12345678")).toBe("+12345678");
    expect(telefoneDe("+123456789012345")).toBe("+123456789012345");
    expect(telefoneDe("+1234567")).toBeNull();
    expect(telefoneDe("+1234567890123456")).toBeNull();
  });

  it("brasileiro truncado com `+` não vira estrangeiro", () => {
    expect(telefoneDe("+55119999")).toBeNull();
    expect(telefoneDe("+55")).toBeNull();
  });
});

/** Ramo 4 e o CONTROLE: sem país no dado, nada de adivinhar. */
describe("o que continua fora (#3080)", () => {
  it("CONTROLE: sem código de país o número segue tratado como brasileiro", () => {
    // 10 dígitos sem `+` é brasileiro para esta função, mesmo parecendo dos EUA.
    expect(telefoneDe("2125551234")).toBe("+552125551234");
    // E 8 dígitos sem `+` continua sem telefone válido — não vira "+12345678".
    expect(telefoneDe("12345678")).toBeNull();
  });

  it("borda: só o sinal de mais, espaço, hífen e número curto não viram telefone", () => {
    expect(telefoneDe("+")).toBeNull();
    expect(telefoneDe("")).toBeNull();
    expect(telefoneDe("   ")).toBeNull();
    expect(telefoneDe("-")).toBeNull();
    expect(telefoneDe("(11) 99999")).toBeNull();
  });

  it("`phoneUnformatted` continua tendo precedência sobre `phone`", () => {
    const p = normalizeProspect({
      title: "Empresa Exemplo",
      placeId: "p-3080",
      phone: "(11) 3333-4444",
      phoneUnformatted: "+351 912 345 678",
    });
    expect(p?.phone).toBe("+351912345678");
  });
});
