import { describe, expect, it } from "vitest";

import type { FlowEdge, FlowGraph, FlowNode } from "./graph-schema";
import { validateFlowForPublish } from "./validate-publish";

/**
 * #1540 — "SOMENTE INTERNO": o fluxo marcou que não fala com o cliente, e a
 * publicação é a ÚLTIMA porta antes de o motor rodar.
 *
 * O critério de aceite é este: um fluxo somente interno com nó de envio é
 * RECUSADO na publicação. Aceitar calado daria ao operador a tela dizendo
 * "publicado" enquanto uma mensagem sairia para o cliente num fluxo que ele
 * achava interno — e a diferença não se vê até o cliente reclamar.
 */

const pos = { x: 0, y: 0 };

function trigger(id: string): FlowNode {
  return { id, type: "trigger", label: id, position: pos, config: {} };
}
function actionText(id: string): FlowNode {
  return { id, type: "action", label: `Enviar ${id}`, position: pos, config: { mode: "text", body: "oi" } };
}
function lembrete(id: string): FlowNode {
  return {
    id,
    type: "internal_task",
    label: `Lembrete ${id}`,
    position: pos,
    config: {
      titulo: "Ligar para {{contact.name}}",
      vence_em_dias: 1,
      atribuir_a: "dono_do_lead",
      prioridade: "high",
    },
  };
}
function end(id: string): FlowNode {
  return { id, type: "end", label: id, position: pos, config: { outcome: "exhausted" } };
}

let seq = 0;
function edge(source: string, target: string): FlowEdge {
  seq += 1;
  return { id: `e${seq}`, source, target, priority: 0, condition: { type: "always" } };
}

function graph(nodes: FlowNode[], edges: FlowEdge[], somenteInterno = true): FlowGraph {
  return { nodes, edges, settings: { max_tentativas_pergunta: 3, somente_interno: somenteInterno } };
}

describe("o fluxo somente interno", () => {
  it("controle positivo: só lembrete interno publica", () => {
    const g = graph(
      [trigger("t1"), lembrete("n1"), end("e1")],
      [edge("t1", "n1"), edge("n1", "e1")],
    );
    expect(validateFlowForPublish(g)).toEqual({ ok: true });
  });

  it("⭐ é RECUSADO quando tem nó de envio", () => {
    const g = graph(
      [trigger("t1"), actionText("a1"), end("e1")],
      [edge("t1", "a1"), edge("a1", "e1")],
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain("interno_com_envio");
      expect(result.errors.find((e) => e.code === "interno_com_envio")?.node_id).toBe("a1");
    }
  });

  it("o MESMO nó de envio publica quando a marca não está ligada", () => {
    const g = graph(
      [trigger("t1"), actionText("a1"), end("e1")],
      [edge("t1", "a1"), edge("a1", "e1")],
      false,
    );
    expect(validateFlowForPublish(g)).toEqual({ ok: true });
  });

  it("o nó internal_task é de follow-up (não cai em no_fora_da_superficie)", () => {
    const g = graph(
      [trigger("t1"), lembrete("n1"), end("e1")],
      [edge("t1", "n1"), edge("n1", "e1")],
    );
    const result = validateFlowForPublish(g, { surface: "crm_automation" });
    expect(result).toEqual({ ok: true });
  });

  it("o nó internal_task NÃO é de roteiro de atendimento", () => {
    const g = graph(
      [trigger("t1"), lembrete("n1"), end("e1")],
      [edge("t1", "n1"), edge("n1", "e1")],
      false,
    );
    const result = validateFlowForPublish(g, { surface: "atendimento" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain("no_fora_da_superficie");
    }
  });
});
