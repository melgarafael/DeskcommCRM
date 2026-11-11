import { describe, expect, it } from "vitest";

import type { FlowNode } from "./graph-schema";
import { carregaEtapasCitadas, idsDeEtapaCitados, nomesDasEtapas } from "./etapas-citadas";

const ID_A = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const ID_B = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
const ID_FUNIL = "0e1f2a3b-4c5d-4e6f-8a7b-1c2d3e4f5a6b";
const pos = { x: 0, y: 0 };

function condicao(id: string, checks: Extract<FlowNode, { type: "condition" }>["config"]["checks"]): FlowNode {
  return { id, type: "condition", label: id, position: pos, config: { combinator: "and", checks } };
}

describe("idsDeEtapaCitados", () => {
  it("colhe só etapa com forma de id, sem repetir, de todo nó de condição", () => {
    const nos: FlowNode[] = [
      condicao("c1", [
        { field: "lead_stage", op: "eq", value: ID_A },
        { field: "lead_stage", op: "neq", value: "PAGO" }, // nome digitado à mão: não é consultável
        { field: "tag", op: "eq", value: ID_B }, // id em outro campo não é etapa
      ]),
      condicao("c2", [{ field: "lead_stage", op: "eq", value: ` ${ID_A} ` }]),
      { id: "t", type: "trigger", label: "t", position: pos, config: {} },
    ];
    expect(idsDeEtapaCitados(nos)).toEqual([ID_A]);
  });
});

type RespostaFalsa = { data: unknown; error: { message: string } | null };

/**
 * Dublê do encadeamento `from().select().eq().in()` — grava o que foi pedido.
 * `crm_stages` e `crm_pipelines` são consultas SEPARADAS (o funil não vem por
 * embed), então cada tabela recebe a sua resposta.
 */
function clienteFalso(resposta: RespostaFalsa, funis: RespostaFalsa = { data: [], error: null }) {
  const pedido: { tabela?: string; tabelas: string[]; filtros: Array<[string, unknown]> } = {
    tabelas: [],
    filtros: [],
  };
  const consultaDe = (tabela: string) => {
    const resp = tabela === "crm_pipelines" ? funis : resposta;
    const consulta = {
      select: () => consulta,
      eq: (col: string, v: unknown) => (pedido.filtros.push([col, v]), consulta),
      in: (col: string, v: unknown) => (pedido.filtros.push([col, v]), Promise.resolve(resp)),
    };
    return consulta;
  };
  return {
    pedido,
    cliente: {
      from: (t: string) => {
        pedido.tabela ??= t;
        pedido.tabelas.push(t);
        return consultaDe(t);
      },
    } as never,
  };
}

describe("carregaEtapasCitadas", () => {
  it("não consulta o banco quando nenhuma regra cita etapa", async () => {
    const { cliente, pedido } = clienteFalso({ data: [], error: null });
    const r = await carregaEtapasCitadas(cliente, "org-1", [condicao("c1", [{ field: "tag", op: "eq", value: "vip" }])]);
    expect(r).toEqual({ ok: true, etapas: new Map() });
    expect(pedido.tabela).toBeUndefined();
  });

  it("filtra pela organização e devolve «Etapa · Funil», com o arquivamento", async () => {
    const { cliente, pedido } = clienteFalso(
      {
        data: [{ id: ID_A, name: "Pago", is_archived: true, is_lost: false, pipeline_id: ID_FUNIL }],
        error: null,
      },
      { data: [{ id: ID_FUNIL, name: "Vendas", settings: null }], error: null },
    );
    const r = await carregaEtapasCitadas(cliente, "org-1", [condicao("c1", [{ field: "lead_stage", op: "eq", value: ID_A }])]);
    expect(pedido.tabela).toBe("crm_stages");
    expect(pedido.tabelas).toEqual(["crm_stages", "crm_pipelines"]);
    expect(pedido.filtros).toContainEqual(["organization_id", "org-1"]);
    expect(r).toEqual({ ok: true, etapas: new Map([[ID_A, { nome: "Pago · Vendas", arquivada: true, isPerda: false, settingsDoFunil: null }]]) });
    if (!r.ok) return;
    expect(nomesDasEtapas(r.etapas).etapa?.(ID_A)).toBe("Pago · Vendas");
    expect(nomesDasEtapas(r.etapas).etapa?.(ID_B)).toBeNull();
  });

  it("falha de leitura vira erro explícito, nunca lista vazia — vazia reprovaria toda etapa como apagada", async () => {
    const { cliente } = clienteFalso({ data: null, error: { message: "timeout" } });
    const r = await carregaEtapasCitadas(cliente, "org-1", [condicao("c1", [{ field: "lead_stage", op: "eq", value: ID_A }])]);
    expect(r).toEqual({ ok: false, mensagem: "timeout" });
  });
});
