/**
 * Mover lead para etapa de perda exige o motivo da perda.
 *
 * Contrato (schema): `lost_reason` é opcional para não invalidar grafo antigo.
 * Publicação: destino de perda sem motivo recusa (`motivo_da_perda_ausente`);
 * motivo fora do vocabulário recusa (`motivo_da_perda_invalido`); etapa comum
 * publica sem motivo e aceita motivo mesmo assim.
 */
import { describe, expect, it } from "vitest";

import { moveLeadConfigSchema, type FlowGraph, type FlowEdge, type FlowNode } from "./graph-schema";
import { idsDeEtapaCitados, carregaEtapasCitadas } from "./etapas-citadas";
import { validateFlowForPublish } from "./validate-publish";
import { decideMotivoDaPerda } from "../leads/motivo-da-perda";

const pos = { x: 0, y: 0 };
const PERDA = "aaaaaaaa-1111-4111-8111-111111111111";
const COMUM = "bbbbbbbb-2222-4222-8222-222222222222";

function trigger(id: string): FlowNode {
  return { id, type: "trigger", label: id, position: pos, config: {} };
}
function end(id: string): FlowNode {
  return { id, type: "end", label: id, position: pos, config: { outcome: "exhausted" } };
}
function edge(source: string, target: string): FlowEdge {
  return { id: `e-${source}-${target}`, source, target, priority: 0, condition: { type: "always" } };
}
function mover(stage_id: string, lost_reason?: string): FlowNode {
  return {
    id: "m1",
    type: "move_lead",
    label: "Mover",
    position: pos,
    config: lost_reason === undefined ? { stage_id } : { stage_id, lost_reason },
  };
}
function grafo(node: FlowNode): FlowGraph {
  return { nodes: [trigger("t1"), node, end("fim")], edges: [edge("t1", node.id), edge(node.id, "fim")] };
}
function banco() {
  return new Map([
    [PERDA, { nome: "Perdido · Vendas", arquivada: false, isPerda: true, settingsDoFunil: { lost_reasons: ["Sem orçamento"] } }],
    [COMUM, { nome: "Proposta · Vendas", arquivada: false, isPerda: false, settingsDoFunil: null }],
  ]);
}
function publicar(g: FlowGraph) {
  const etapas = new Map(idsDeEtapaCitados(g.nodes).flatMap((id) => (banco().has(id) ? [[id, banco().get(id)!] as const] : [])));
  return validateFlowForPublish(g, { etapas });
}
const codigos = (r: ReturnType<typeof validateFlowForPublish>) => (r.ok ? [] : r.errors.map((e) => e.code));

describe("moveLeadConfigSchema — contrato do bloco", () => {
  it("aceita o grafo antigo, só com stage_id", () => {
    expect(moveLeadConfigSchema.safeParse({ stage_id: COMUM }).success).toBe(true);
  });

  it("aceita com lost_reason", () => {
    const r = moveLeadConfigSchema.safeParse({ stage_id: PERDA, lost_reason: "no_response" });
    expect(r.success).toBe(true);
  });

  it("recusa motivo com mais de 500 caracteres", () => {
    expect(moveLeadConfigSchema.safeParse({ stage_id: PERDA, lost_reason: "x".repeat(501) }).success).toBe(false);
  });

  it("recusa chave extra desconhecida (strictObject)", () => {
    expect(moveLeadConfigSchema.safeParse({ stage_id: PERDA, pipeline_id: "f1" }).success).toBe(false);
  });
});

describe("publish — etapa de perda exige motivo", () => {
  it("recusa perda sem motivo e diz o que fazer", () => {
    const r = publicar(grafo(mover(PERDA)));
    expect(codigos(r)).toEqual(["motivo_da_perda_ausente"]);
    if (r.ok) return;
    expect(r.errors[0]!.message).toMatch(/motivo da perda/i);
  });

  it("recusa perda com motivo só de espaços", () => {
    expect(codigos(publicar(grafo(mover(PERDA, "   "))))).toEqual(["motivo_da_perda_ausente"]);
  });

  it("aceita motivo canônico (no_response)", () => {
    expect(publicar(grafo(mover(PERDA, "no_response")))).toEqual({ ok: true });
  });

  it("aceita motivo extra do funil", () => {
    expect(publicar(grafo(mover(PERDA, "Sem orçamento")))).toEqual({ ok: true });
  });

  it("recusa motivo fora da lista", () => {
    const r = publicar(grafo(mover(PERDA, "virou poeira")));
    expect(codigos(r)).toEqual(["motivo_da_perda_invalido"]);
    if (r.ok) return;
    expect(r.errors[0]!.message).toMatch(/lista deste funil/);
  });

  it("etapa comum publica sem motivo — e aceita motivo mesmo assim", () => {
    expect(publicar(grafo(mover(COMUM)))).toEqual({ ok: true });
    expect(publicar(grafo(mover(COMUM, "no_response")))).toEqual({ ok: true });
  });
});

describe("a decisão da casa que o publish espelha", () => {
  it("perda sem motivo novo e sem motivo gravado é lost_reason_required", () => {
    const v = decideMotivoDaPerda({ etapaDeDestino: { id: PERDA, is_lost: true }, motivo: null, motivoAtual: null });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.codigo).toBe("lost_reason_required");
  });

  it("perda com motivo passa e o patch grava junto", () => {
    expect(
      decideMotivoDaPerda({ etapaDeDestino: { id: PERDA, is_lost: true }, motivo: "no_response", motivoAtual: null }),
    ).toEqual({ ok: true, patch: { lost_reason: "no_response" } });
  });
});

describe("carregaEtapasCitadas — lê is_lost e os motivos do funil", () => {
  it("traz se é perda e o settings do funil, filtrando pela organização", async () => {
    const pedido: { tabela?: string; filtros: Array<[string, unknown]> } = { filtros: [] };
    const consulta = {
      select: () => consulta,
      eq: (col: string, v: unknown) => (pedido.filtros.push([col, v]), consulta),
      in: () =>
        Promise.resolve({
          data: [
            { id: PERDA, name: "Perdido", is_archived: false, is_lost: true, crm_pipelines: { name: "Vendas", settings: { lost_reasons: ["Sem orçamento"] } } },
          ],
          error: null,
        }),
    };
    const cliente = { from: (t: string) => ((pedido.tabela = t), consulta) } as never;
    const r = await carregaEtapasCitadas(cliente, "org-1", [mover(PERDA, "no_response")]);
    expect(pedido.tabela).toBe("crm_stages");
    expect(pedido.filtros).toContainEqual(["organization_id", "org-1"]);
    expect(r).toEqual({
      ok: true,
      etapas: new Map([
        [PERDA, { nome: "Perdido · Vendas", arquivada: false, isPerda: true, settingsDoFunil: { lost_reasons: ["Sem orçamento"] } }],
      ]),
    });
  });
});
