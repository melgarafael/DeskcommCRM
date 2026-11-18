import { describe, expect, it } from "vitest";

import {
  GRUPOS_DE_ITENS_DA_BUSCA,
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

  it("fonte vazia não inventa grupo", () => {
    expect(itensDaBusca({})).toEqual([]);
    expect(itensDaBusca({ funis: [] })).toEqual([]);
  });
});
