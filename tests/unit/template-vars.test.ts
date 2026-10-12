import { describe, expect, it } from "vitest";

import { faltouNomeDeContato, interpolateTemplate } from "@/lib/inbox/template-vars";

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
