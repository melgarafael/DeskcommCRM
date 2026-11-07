/**
 * A busca do funil ignora ACENTO (#3918, fatia 2).
 *
 * O funil filtra no CLIENTE (`applyFilters`), então não há coluna gerada para
 * consultar: a normalização é a MESMA régua da busca do inbox
 * (`lib/inbox/termo-de-busca.ts`), aplicada dos DOIS lados — termo e texto do
 * card. Antes daqui era só `.toLowerCase()`: "andreia" não achava "Andréia" e
 * "joao" não achava "João", o mesmo buraco que o #3924 fechou no inbox.
 */
import { describe, expect, it } from "vitest";

import { applyFilters } from "@/lib/kanban/filters";
import type { Lead } from "@/lib/types/leads";

const card = (id: string, extra: Partial<Lead>): Lead =>
  ({ id, title: "Negócio", description: null, status: "open", tags: [], ...extra }) as Lead;

const leads = [
  card("andreia", { title: "Compra da Andréia" }),
  card("andreia-sem-acento", { title: "Compra da Andreia" }),
  card("joao", { title: "Retorno do João", description: "pediu orçamento de serviço" }),
  card("conceicao", { title: "Conceição — plano anual" }),
  card("ana-maria", { title: "Ana-Maria D'Avila" }),
  card("outro", { title: "Josefina Souza", contact_phone: "+5511999998888" }),
];

const buscar = (search: string) => applyFilters(leads, { search }).map((l) => l.id);

describe("applyFilters — busca sem acento (#3918)", () => {
  it('"Andreia" acha os dois cadastros (com e sem acento)', () => {
    expect(buscar("Andreia").sort()).toEqual(["andreia", "andreia-sem-acento"]);
  });

  it('"Andréia" acha o mesmo conjunto — simetria', () => {
    expect(buscar("Andréia").sort()).toEqual(["andreia", "andreia-sem-acento"]);
  });

  it('"joao" acha "João" e "JOÃO" acha "João"', () => {
    expect(buscar("joao")).toEqual(["joao"]);
    expect(buscar("JOÃO")).toEqual(["joao"]);
  });

  it("acha no description também — não só no título", () => {
    expect(buscar("orcamento")).toEqual(["joao"]);
  });

  it('"Conceicao" acha "Conceição" e "conceicao" acha a mesma coisa', () => {
    expect(buscar("Conceicao")).toEqual(["conceicao"]);
  });

  it("hífen e apóstrofo continuam literais", () => {
    expect(buscar("Ana-Maria")).toEqual(["ana-maria"]);
    expect(buscar("D'Avila")).toEqual(["ana-maria"]);
  });

  it("não vira 'acha tudo': termo sem relação continua devolvendo vazio", () => {
    expect(buscar("zebedeu")).toEqual([]);
  });

  it("telefone por dígitos continua funcionando", () => {
    expect(buscar("(11) 99999-8888")).toEqual(["outro"]);
    expect(buscar("999998888")).toEqual(["outro"]);
  });

  it("caixa continua indiferente para termo sem acento", () => {
    expect(buscar("JOSEFINA")).toEqual(["outro"]);
  });
});
