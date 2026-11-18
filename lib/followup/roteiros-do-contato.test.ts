import { describe, expect, it } from "vitest";

import { montarRoteirosDoContato } from "./roteiros-do-contato";

const GRAFO = {
  nodes: [
    { id: "t", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
    {
      id: "c1",
      type: "collect",
      label: "Nome",
      position: { x: 0, y: 0 },
      config: { key: "nome_completo", label: "Nome completo", type: "text", required: true, permite_correcao: true },
    },
    {
      id: "c2",
      type: "collect",
      label: "CPF",
      position: { x: 0, y: 0 },
      config: { key: "cpf", label: "CPF", type: "cpf", required: true, permite_correcao: true },
    },
    { id: "e", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [
    { id: "a", source: "t", target: "c1", priority: 0, condition: { type: "always" } },
    { id: "b", source: "c1", target: "c2", priority: 0, condition: { type: "always" } },
    { id: "c", source: "c2", target: "e", priority: 0, condition: { type: "always" } },
  ],
};

describe("montarRoteirosDoContato (o que a ficha mostra)", () => {
  it("rótulo e valor na ordem das perguntas; o que falta vem nulo", () => {
    const [r] = montarRoteirosDoContato(
      [{ id: "e1", status: "coletando", started_at: "2026-09-24T10:00:00Z", completed_at: null, nome: "Cadastro", graph: GRAFO }],
      { nome_completo: "Lia Mendes", outro_campo: "x" },
    );
    expect(r).toEqual({
      enrollment_id: "e1",
      nome: "Cadastro",
      status: "coletando",
      iniciado_em: "2026-09-24T10:00:00Z",
      concluido_em: null,
      campos: [
        { key: "nome_completo", label: "Nome completo", valor: "Lia Mendes" },
        { key: "cpf", label: "CPF", valor: null },
      ],
    });
  });

  it("pergunta gravada no NEGÓCIO é marcada: o valor não é do contato (#3363)", () => {
    // Sem a marca a ficha diria "não respondido" para uma pergunta que o fluxo
    // fez e gravou — só que no card do negócio, não no cadastro do cliente.
    const comNegocio = {
      ...GRAFO,
      nodes: [
        ...GRAFO.nodes,
        {
          id: "c3",
          type: "collect",
          label: "Destino da viagem",
          position: { x: 0, y: 0 },
          config: {
            key: "destino_viagem",
            label: "Destino da viagem",
            type: "text",
            required: true,
            permite_correcao: true,
            destino: "negocio",
          },
        },
      ],
      edges: [
        GRAFO.edges[0]!,
        GRAFO.edges[1]!,
        { id: "c2-c3", source: "c2", target: "c3", priority: 0, condition: { type: "always" } },
        { id: "c3-e", source: "c3", target: "e", priority: 0, condition: { type: "always" } },
      ],
    };
    const [r] = montarRoteirosDoContato(
      [{ id: "e1", status: "coletando", started_at: "2026-09-24T10:00:00Z", completed_at: null, nome: "Viagem", graph: comNegocio }],
      { nome_completo: "Lia Mendes" },
    );
    expect(r!.campos).toEqual([
      { key: "nome_completo", label: "Nome completo", valor: "Lia Mendes" },
      { key: "cpf", label: "CPF", valor: null },
      { key: "destino_viagem", label: "Destino da viagem", valor: null, onde: "negocio" },
    ]);
  });

  it("grafo que não é roteiro (ou corrompido) não entra", () => {
    expect(
      montarRoteirosDoContato(
        [{ id: "e1", status: "completed", started_at: "x", completed_at: null, nome: "X", graph: { nodes: [] } }],
        {},
      ),
    ).toEqual([]);
  });
});
