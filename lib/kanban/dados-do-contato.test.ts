import { describe, expect, it } from "vitest";

import type { Lead } from "@/lib/types/leads";

import { anexarDadosDoContato, type LinhaDoContatoNoQuadro } from "./dados-do-contato";

const lead = (id: string, contact_id: string | null): Lead => ({ id, contact_id }) as Lead;

const contato = (
  id: string,
  resto: Partial<LinhaDoContatoNoQuadro> = {},
): LinhaDoContatoNoQuadro => ({
  id,
  phone_number: null,
  email: null,
  custom_fields: null,
  is_anonymized: false,
  ...resto,
});

describe("anexarDadosDoContato — o que o card do funil recebe do contato", () => {
  it("⭐ anexa telefone, e-mail e só os links válidos", () => {
    const leads = anexarDadosDoContato(
      [lead("l1", "c1")],
      [
        contato("c1", {
          phone_number: "+5511999998888",
          email: "ana@exemplo.com",
          custom_fields: {
            link_instagram: "instagram.com/loja",
            link_site: "exemplo.com.br",
            link_facebook: "javascript:alert(1)",
            cor_favorita: "azul",
          },
        }),
      ],
    );

    expect(leads[0]).toMatchObject({
      id: "l1",
      contact_phone: "+5511999998888",
      contact_email: "ana@exemplo.com",
      contact_links: [
        { tipo: "instagram", href: "https://instagram.com/loja" },
        { tipo: "site", href: "https://exemplo.com.br/" },
      ],
    });
    // o link perigoso e o campo que não é link não vazam para o card
    const json = JSON.stringify(leads[0]);
    expect(json).not.toContain("javascript");
    expect(json).not.toContain("cor_favorita");
  });

  it("⭐ contato anonimizado (LGPD) não devolve nada, mesmo com a linha ainda preenchida", () => {
    const leads = anexarDadosDoContato(
      [lead("l1", "c1")],
      [contato("c1", { phone_number: "+5511999998888", email: "ana@exemplo.com", is_anonymized: true })],
    );

    expect(leads[0]).not.toHaveProperty("contact_phone");
    expect(leads[0]).not.toHaveProperty("contact_email");
    expect(leads[0]).not.toHaveProperty("contact_links");
  });

  it("vazio não vira campo — o payload do quadro não engorda", () => {
    const leads = anexarDadosDoContato([lead("l1", "c1")], [contato("c1", { email: "ana@exemplo.com" })]);

    expect(Object.keys(leads[0]!).sort()).toEqual(["contact_email", "contact_id", "id"]);
  });

  it("negócio sem contato passa intacto (o mesmo objeto), ao lado de um que recebe dados", () => {
    const semContato = lead("l1", null);
    const comContato = lead("l2", "c1");

    const leads = anexarDadosDoContato(
      [semContato, comContato],
      [contato("c1", { email: "ana@exemplo.com" })],
    );

    expect(leads[0]).toBe(semContato);
    expect(leads[1]).toMatchObject({ id: "l2", contact_email: "ana@exemplo.com" });
  });

  it("contato que ninguém tem dado a mostrar não altera a lista", () => {
    const original = [lead("l1", "c1")];

    expect(anexarDadosDoContato(original, [contato("c1")])).toBe(original);
  });

  it("cada negócio recebe o dado do SEU contato, e dois negócios do mesmo contato recebem o mesmo", () => {
    const leads = anexarDadosDoContato(
      [lead("l1", "c1"), lead("l2", "c2"), lead("l3", "c1")],
      [
        contato("c1", { email: "um@exemplo.com" }),
        contato("c2", { email: "dois@exemplo.com" }),
      ],
    );

    expect(leads.map((l) => l.contact_email)).toEqual([
      "um@exemplo.com",
      "dois@exemplo.com",
      "um@exemplo.com",
    ]);
  });
});
