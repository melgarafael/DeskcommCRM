import { describe, expect, it } from "vitest";

import { faltouNomeDeContato, interpolateTemplate, MOTIVO_CURINGA_LITERAL, motivoDoCuringaLiteral } from "@/lib/inbox/template-vars";

describe("interpolateTemplate", () => {
  it("substitui nome e primeiro_nome", () => {
    expect(interpolateTemplate("Oi {{primeiro_nome}}, tudo bem?", { name: "Rafael Melgaço" })).toBe(
      "Oi Rafael, tudo bem?",
    );
    expect(interpolateTemplate("Falo com {{nome}}?", { name: "Rafael Melgaço" })).toBe(
      "Falo com Rafael Melgaço?",
    );
  });
  it("tolera espaços e case nas chaves", () => {
    expect(interpolateTemplate("Oi {{ Primeiro_Nome }}!", { name: "Ana Paula" })).toBe("Oi Ana!");
  });
  it("sem nome → mantém o literal (não quebra)", () => {
    expect(interpolateTemplate("Oi {{primeiro_nome}}", { name: null })).toBe("Oi {{primeiro_nome}}");
  });
  it("variável desconhecida → mantém o literal", () => {
    expect(interpolateTemplate("Cupom {{codigo}}", { name: "X" })).toBe("Cupom {{codigo}}");
  });
  // Fallback name → displayName (#2744): contato que só tem `display_name` não
  // podia mandar `{{nome}}` literal pro cliente.
  it("sem name → cai no displayName", () => {
    expect(
      interpolateTemplate("Oi {{primeiro_nome}}, tudo bem?", {
        name: null,
        displayName: "Rafael Melgaço",
      }),
    ).toBe("Oi Rafael, tudo bem?");
    expect(
      interpolateTemplate("Falo com {{nome}}?", { name: null, displayName: "Rafael Melgaço" }),
    ).toBe("Falo com Rafael Melgaço?");
  });
  it("name em branco → cai no displayName", () => {
    expect(
      interpolateTemplate("Oi {{nome}}", { name: "   ", displayName: "Ana Paula" }),
    ).toBe("Oi Ana Paula");
  });
  it("name preenchido vence o displayName", () => {
    expect(
      interpolateTemplate("Oi {{nome}}", { name: "Rafael Melgaço", displayName: "Cliente 5511" }),
    ).toBe("Oi Rafael Melgaço");
  });
  it("displayName ausente ou em branco → mantém o literal", () => {
    expect(interpolateTemplate("Oi {{nome}}", { name: null, displayName: null })).toBe(
      "Oi {{nome}}",
    );
    expect(interpolateTemplate("Oi {{nome}}", { name: null, displayName: "  " })).toBe(
      "Oi {{nome}}",
    );
  });
  it("displayName é aparado antes de virar primeiro_nome", () => {
    // `\n` colado (caso de rótulo vindo do canal) viraria "primeiro nome" com
    // quebra de linha dentro do texto mandado ao cliente.
    expect(
      interpolateTemplate("Oi {{primeiro_nome}}!", { name: null, displayName: "Rafael\n Melgaço" }),
    ).toBe("Oi Rafael!");
  });
});

describe("identificador técnico não vira nome (regra de nomeDoContato)", () => {
  // `display_name` de resíduo (`Contato 543134@lid`) não é nome de gente: a
  // regra central (`lib/contacts/rotulo-do-contato.ts`) o recusa, e o template
  // não pode mandar "Oi Contato" ao cliente.
  it("display_name técnico → mantém o literal e avisa", () => {
    const contato = { name: null, displayName: "Contato 543134@lid" };
    expect(interpolateTemplate("Oi {{primeiro_nome}}!", contato)).toBe("Oi {{primeiro_nome}}!");
    expect(faltouNomeDeContato("Oi {{primeiro_nome}}!", contato)).toBe(true);
  });
  it("name técnico cai no display_name de gente", () => {
    expect(
      interpolateTemplate("Oi {{nome}}", { name: "5531988887777@c.us", displayName: "Ana Paula" }),
    ).toBe("Oi Ana Paula");
  });
});

describe("faltouNomeDeContato", () => {
  it("true: tem variável de nome e o contato não tem nenhum nome", () => {
    expect(faltouNomeDeContato("Oi {{nome}}, tudo bem?", { name: null })).toBe(true);
    expect(faltouNomeDeContato("Oi {{primeiro_nome}}!", { name: "", displayName: null })).toBe(true);
  });
  it("false: displayName cobre a variável", () => {
    expect(
      faltouNomeDeContato("Oi {{nome}}", { name: null, displayName: "Rafael Melgaço" }),
    ).toBe(false);
  });
  it("false: nome preenchido cobre a variável", () => {
    expect(faltouNomeDeContato("Oi {{nome}}", { name: "Rafael" })).toBe(false);
  });
  it("false: variável desconhecida não é problema de nome", () => {
    expect(faltouNomeDeContato("Cupom {{codigo}}", { name: null })).toBe(false);
  });
  it("tolera espaços e case na chave", () => {
    expect(faltouNomeDeContato("Oi {{ Primeiro_Nome }}!", { name: null })).toBe(true);
  });
});

describe("motivoDoCuringaLiteral (#2744)", () => {
  // A decisão de barra/libera mora na FUNÇÃO PURA, e não só no componente: o
  // repositório não tem `Composer.test.tsx`, e a lógica que barra o envio não
  // pode depender de render para ser provada.
  it("curinga de nome literal sobrevivente → o motivo fixo (barra a resposta)", () => {
    expect(motivoDoCuringaLiteral("Oi {{nome}}, tudo bem?", { name: null })).toBe(
      MOTIVO_CURINGA_LITERAL,
    );
    expect(
      motivoDoCuringaLiteral("Oi {{primeiro_nome}}!", { name: "", displayName: null }),
    ).toBe(MOTIVO_CURINGA_LITERAL);
  });
  it("contato COM nome → null: nada barrado, o curinga resolve", () => {
    expect(motivoDoCuringaLiteral("Oi {{nome}}", { name: "Rafael" })).toBeNull();
    expect(
      motivoDoCuringaLiteral("Oi {{nome}}", { name: null, displayName: "Rafael Melgaço" }),
    ).toBeNull();
  });
  it("nome técnico (Contato …@lid) não cobre a variável → motivo (barra)", () => {
    expect(
      motivoDoCuringaLiteral("Oi {{primeiro_nome}}!", {
        name: null,
        displayName: "Contato 543134@lid",
      }),
    ).toBe(MOTIVO_CURINGA_LITERAL);
  });
  it("chave desconhecida → null: `{{codigo}}` cru não é problema de nome", () => {
    expect(motivoDoCuringaLiteral("Cupom {{codigo}}", { name: null })).toBeNull();
  });
});
