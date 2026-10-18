/**
 * Seguimento do #3056 — o publish confere que o modelo de mensagem de cada passo
 * EXISTE nesta organização. Antes, um fluxo importado de outra conta (ou com o
 * modelo apagado) publicava e o motor lançava a cada envio (`followup-turn.ts`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { FlowEdge, FlowGraph, FlowNode } from "./graph-schema";
import { carregaModelosCitados, idsDeModeloCitados } from "./modelos-citados";
import { MENSAGEM_MODELO_INEXISTENTE, validateFlowForPublish } from "./validate-publish";

const pos = { x: 0, y: 0 };
const ORG = "11111111-1111-4111-8111-111111111111";
const DA_CONTA = "22222222-2222-4222-8222-222222222222";
const DE_FORA = "33333333-3333-4333-8333-333333333333";
const PLANO_B_DE_FORA = "44444444-4444-4444-8444-444444444444";

function fluxo(...acoes: FlowNode[]): FlowGraph {
  const ids = ["t", ...acoes.map((a) => a.id), "fim"];
  const nodes: FlowNode[] = [
    { id: "t", type: "trigger", label: "t", position: pos, config: {} },
    ...acoes,
    { id: "fim", type: "end", label: "fim", position: pos, config: { outcome: "exhausted" } },
  ];
  const edges: FlowEdge[] = ids.slice(1).map((alvo, i) => ({
    id: `e${i}`,
    source: ids[i]!,
    target: alvo,
    priority: 0,
    condition: { type: "always" },
  }));
  return { nodes, edges };
}
const modelo = (id: string, templateId: string): FlowNode => ({
  id,
  type: "action",
  label: id,
  position: pos,
  config: { mode: "template", template_id: templateId },
});
const ia = (id: string, fallback?: string): FlowNode => ({
  id,
  type: "action",
  label: id,
  position: pos,
  config: { mode: "ai_message", prompt_hint: "oi", ...(fallback ? { fallback_template_id: fallback } : {}) },
});

describe("validateFlowForPublish — modelo que não existe nesta conta", () => {
  it("reprova o passo de modelo e o plano B que a conta não tem, um problema por nó", () => {
    const r = validateFlowForPublish(fluxo(modelo("m1", DE_FORA), ia("ia1", PLANO_B_DE_FORA)), {
      modelos: { prontos: new Set([DA_CONTA]), doCanal: new Set([DA_CONTA]) },
      exigeModeloForaDaJanela: false,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([
      { node_id: "ia1", code: "modelo_inexistente", message: MENSAGEM_MODELO_INEXISTENTE },
      { node_id: "m1", code: "modelo_inexistente", message: MENSAGEM_MODELO_INEXISTENTE },
    ]);
  });

  it("passa quando o modelo existe na conta", () => {
    const r = validateFlowForPublish(fluxo(modelo("m1", DA_CONTA), ia("ia1", DA_CONTA), ia("ia2")), {
      modelos: { prontos: new Set(), doCanal: new Set([DA_CONTA]) },
      exigeModeloForaDaJanela: false,
    });
    expect(r).toEqual({ ok: true });
  });

  it("o passo de modelo aceita texto pronto; o plano B, só modelo do canal — é o que o motor lê", () => {
    const r = validateFlowForPublish(fluxo(modelo("m1", DA_CONTA), ia("ia1", DA_CONTA)), {
      modelos: { prontos: new Set([DA_CONTA]), doCanal: new Set() },
      exigeModeloForaDaJanela: false,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([{ node_id: "ia1", code: "modelo_inexistente", message: MENSAGEM_MODELO_INEXISTENTE }]);
  });

  it("sem o conjunto do banco a conferência não roda — nunca adivinha", () => {
    expect(validateFlowForPublish(fluxo(modelo("m1", DE_FORA)))).toEqual({ ok: true });
  });
});

/** Cliente falso que REGISTRA cada filtro, para provar que a org da sessão chega às duas tabelas. */
function clienteQueRegistra(linhas: Record<string, { id: string }[]>) {
  const filtros: string[] = [];
  const client = {
    from(tabela: string) {
      const q = {
        select: (c: string) => (filtros.push(`${tabela}.select(${c})`), q),
        eq: (col: string, v: string) => (filtros.push(`${tabela}.eq(${col},${v})`), q),
        in: (col: string, vs: string[]) => {
          filtros.push(`${tabela}.in(${col},${vs.join("|")})`);
          return Promise.resolve({ data: linhas[tabela] ?? [], error: null });
        },
      };
      return q;
    },
  };
  return { client: client as unknown as SupabaseClient, filtros };
}

describe("carregaModelosCitados", () => {
  it("filtra organization_id nas DUAS tabelas e junta o que existe", async () => {
    const { client, filtros } = clienteQueRegistra({
      message_templates: [{ id: DA_CONTA }],
      meta_templates: [{ id: PLANO_B_DE_FORA }],
    });
    const r = await carregaModelosCitados(client, ORG, fluxo(modelo("m1", DA_CONTA), ia("ia1", PLANO_B_DE_FORA)).nodes);
    expect(r).toEqual({ ok: true, modelos: { prontos: new Set([DA_CONTA]), doCanal: new Set([PLANO_B_DE_FORA]) } });
    expect(filtros).toEqual([
      "message_templates.select(id)",
      `message_templates.eq(organization_id,${ORG})`,
      `message_templates.in(id,${DA_CONTA}|${PLANO_B_DE_FORA})`,
      "meta_templates.select(id)",
      `meta_templates.eq(organization_id,${ORG})`,
      `meta_templates.in(id,${DA_CONTA}|${PLANO_B_DE_FORA})`,
    ]);
  });

  it("sem modelo citado não consulta nada", async () => {
    const { client, filtros } = clienteQueRegistra({});
    expect(await carregaModelosCitados(client, ORG, fluxo(ia("ia1")).nodes)).toEqual({
      ok: true,
      modelos: { prontos: new Set(), doCanal: new Set() },
    });
    expect(filtros).toEqual([]);
  });

  it("erro de leitura não vira 'modelo apagado'", async () => {
    const client = {
      from: () => ({
        select: () => ({ eq: () => ({ in: () => Promise.resolve({ data: null, error: { message: "caiu" } }) }) }),
      }),
    } as unknown as SupabaseClient;
    expect(await carregaModelosCitados(client, ORG, fluxo(modelo("m1", DA_CONTA)).nodes)).toEqual({
      ok: false,
      mensagem: "caiu",
    });
  });

  it("idsDeModeloCitados lê template_id e fallback_template_id, sem repetir", () => {
    expect(idsDeModeloCitados(fluxo(modelo("m1", DA_CONTA), ia("ia1", DA_CONTA), ia("ia2")).nodes)).toEqual([DA_CONTA]);
  });
});
