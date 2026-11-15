import { describe, expect, it } from "vitest";

import {
  GRUPOS_DE_ITENS_DA_BUSCA,
  filtrarItensDaBusca,
  itensDaBusca,
  type FontesDosItensDaBusca,
} from "./itens-da-paleta";

/**
 * O caso da comunidade (#4593): treze fluxos de retomada com nomes parecidos,
 * dois funis de prospecção e os agentes que rodam por trás deles. O ⌘K tem de
 * devolver o ITEM, não a tela em que ele mora.
 */
const FONTES: FontesDosItensDaBusca = {
  funis: [
    { id: "funil-prospeccao-site", name: "Prospecção (Site)" },
    { id: "funil-obras", name: "Obras e Reformas" },
  ],
  fluxos: [
    { id: "fluxo-oficinas", name: "Kelly · retomada (oficinas mecânica)" },
    { id: "fluxo-pos-venda", name: "Pós-venda 30 dias" },
  ],
  agentes: [
    { id: "agente-kelly", name: "Kelly", description: "Retomada de pré-vendas por WhatsApp" },
    { id: "agente-suporte", name: "Suporte técnico", description: null },
  ],
};

const itens = itensDaBusca(FONTES);
const achados = (termo: string) => filtrarItensDaBusca(itens, termo);

describe("⌘K: fluxos, funis e agentes como itens da busca (#4593)", () => {
  it("devolve os TRÊS tipos, cada um no seu grupo e com o destino do registro", () => {
    expect(itens).toHaveLength(6);
    expect(new Set(itens.map((i) => i.group))).toEqual(new Set(["funis", "followups", "agentes"]));

    // O destino abre o ITEM: rota do registro, nunca a rota da lista.
    expect(itens.map((i) => i.href)).toEqual([
      "/app/pipelines/funil-prospeccao-site",
      "/app/pipelines/funil-obras",
      "/app/ai/followups/fluxo-oficinas",
      "/app/ai/followups/fluxo-pos-venda",
      "/app/ai/agents/agente-kelly",
      "/app/ai/agents/agente-suporte",
    ]);

    // Os rótulos dos grupos são os que a issue pediu, e são chave do dicionário.
    expect(GRUPOS_DE_ITENS_DA_BUSCA.map((g) => g.label)).toEqual([
      "Funis",
      "Follow-ups",
      "Agentes de IA",
    ]);
  });

  it("acha o FUNIL por trecho do nome e abre o funil certo", () => {
    expect(achados("prospeccao").map((i) => i.href)).toEqual([
      "/app/pipelines/funil-prospeccao-site",
    ]);
    expect(achados("(site)").map((i) => i.label)).toEqual(["Prospecção (Site)"]);
  });

  it("acha o FLUXO por trecho do nome, sem acento e sem caixa", () => {
    expect(achados("oficinas").map((i) => i.href)).toEqual(["/app/ai/followups/fluxo-oficinas"]);
    expect(achados("POS-VENDA").map((i) => i.href)).toEqual(["/app/ai/followups/fluxo-pos-venda"]);
  });

  it("acha o AGENTE pela DESCRIÇÃO, como já acontece na lista de Agentes", () => {
    expect(achados("pre-vendas").map((i) => i.href)).toEqual(["/app/ai/agents/agente-kelly"]);
    expect(achados("whatsapp").map((i) => i.label)).toEqual(["Kelly"]);
  });

  it("quem digita o nome do grupo vê o grupo inteiro", () => {
    expect(achados("funis")).toHaveLength(2);
    expect(achados("follow-ups")).toHaveLength(2);
    expect(achados("agentes")).toHaveLength(2);
  });

  it("fonte vazia não inventa grupo", () => {
    expect(itensDaBusca({})).toEqual([]);
    expect(itensDaBusca({ funis: [] })).toEqual([]);
  });
});

describe("⌘K: controle negativo, sem termo (#4593)", () => {
  it("sem termo, os três grupos voltam COMPLETOS e na mesma referência", () => {
    // É o catálogo que a paleta mostra antes da primeira letra: nenhum item pode
    // sumir por causa do filtro.
    expect(filtrarItensDaBusca(itens, "")).toBe(itens);
    expect(filtrarItensDaBusca(itens, "   ")).toBe(itens);

    const porGrupo = (grupo: string) => itens.filter((i) => i.group === grupo).length;
    expect(porGrupo("funis")).toBe(2);
    expect(porGrupo("followups")).toBe(2);
    expect(porGrupo("agentes")).toBe(2);
  });
});
