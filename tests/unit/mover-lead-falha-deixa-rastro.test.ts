/**
 * A recusa do `move_lead` deixa rastro na trilha da inscrição.
 *
 * Antes, a falha do motor era só `logger.warn("followup_move_lead_failed")`:
 * quem montava o fluxo via o fim "concluído" sem saber que o card continuava
 * aberto. Agora o `catch` insere `move_lead_failed` — com chave própria para o
 * replay não duplicar e com registro à prova de falha do próprio registro.
 *
 * Molde: `tests/unit/nos-de-acao-do-followup-2065.test.ts` (o claim drena a
 * fila, o evento do passo é a trava). Aqui o dublê grava também a
 * `idempotency_key`, que é o que estes casos conferem.
 */
import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/types";
import {
  runFollowupTick,
  type AdminClient,
  type TickDeps,
  type FollowupJobRequest,
} from "@/lib/followup/engine";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import { flowGraphSchema } from "@/lib/followup/graph-schema";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const ETAPA = "33333333-3333-4333-8333-333333333333";

function enrollment(currentNodeId: string): EnrollmentRow {
  return {
    id: "e1",
    organization_id: ORG,
    pointer_id: "p1",
    version_id: "v1",
    contact_id: CONTATO,
    conversation_id: null,
    current_node_id: currentNodeId,
    status: "active",
    next_eval_at: new Date().toISOString(),
    claimed_until: null,
    attempts: 0,
    max_attempts: 3,
    last_error: null,
    steps_taken: 0,
    outcome: null,
    cancel_reason: null,
    started_at: new Date().toISOString(),
    completed_at: null,
    updated_at: new Date().toISOString(),
  };
}

function grafo(): unknown {
  const nos = [
    { id: "n1", type: "trigger", label: "nó n1", position: { x: 0, y: 0 }, config: {} },
    { id: "n2", type: "move_lead", label: "nó n2", position: { x: 100, y: 0 }, config: { stage_id: ETAPA } },
    { id: "fim", type: "end", label: "nó fim", position: { x: 200, y: 0 }, config: { outcome: "converted" } },
  ];
  return {
    nodes: nos,
    edges: nos.slice(0, -1).map((n, i) => ({
      id: `e-${n.id}-${nos[i + 1]!.id}`,
      source: n.id,
      target: nos[i + 1]!.id,
      condition: { type: "always" },
    })),
  };
}

type EventoGravado = {
  event_type: string;
  node_id: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
};

/** Cenário com o `moverLeadNoFunil` recusando e o insert observável por chave. */
function cenario(falhaNoInsertDoRastro: boolean) {
  const eventos: EventoGravado[] = [];
  const patches: Array<Record<string, unknown>> = [];
  const jobs: FollowupJobRequest[] = [];
  const fila = [enrollment("n2")];

  const db: AdminClient = {
    async claimDueEnrollments() {
      return fila.splice(0, fila.length);
    },
    async loadFlowGraph() {
      return flowGraphSchema.parse(grafo());
    },
    async loadLeadFacts() {
      return { lead_stage: "etapa-a", tags: [], contact_name: null, custom_fields: {} };
    },
    async loadEnrollmentEvents() {
      return [];
    },
    async insertEnrollmentEvent(event) {
      if (falhaNoInsertDoRastro && event.event_type === "move_lead_failed") {
        throw new Error("banco fora do ar");
      }
      eventos.push({
        event_type: event.event_type,
        node_id: event.node_id,
        payload: event.payload,
        idempotency_key: event.idempotency_key,
      });
      return { inserted: true };
    },
    async updateEnrollment(_id, _org, patch) {
      patches.push(patch as Record<string, unknown>);
    },
    async moverLeadNoFunil() {
      throw new ApiError(422, "lost_reason_required", undefined, "req-1", "Informe o motivo da perda.");
    },
    async loadLastInboundBody() {
      return null;
    },
    async loadFlowPointerName() {
      return null;
    },
    async insertDeadInboxItem() {},
    async persistirRespostaFollowup() {},
  };

  const deps: TickDeps = {
    db,
    clock: () => new Date("2026-10-03T12:00:00.000Z"),
    enqueueJob: async (job) => {
      jobs.push(job);
    },
  };

  return { deps, eventos, patches, jobs };
}

describe("move_lead recusado deixa rastro na trilha", () => {
  it("insere move_lead_failed com a mensagem, o código e chave própria", async () => {
    const c = cenario(false);

    const resumo = await runFollowupTick(c.deps);

    // O avanço segue (o tick seguinte não tenta de novo), mas o rastro fica.
    expect(resumo.failed).toBe(0);
    expect(resumo.advanced).toBe(1);
    expect(c.patches[0]).toMatchObject({ current_node_id: "fim", steps_taken: 1 });
    expect(c.eventos).toEqual([
      { event_type: "node_advanced", node_id: "n2", payload: { next_node_id: "fim" }, idempotency_key: "n2:0" },
      {
        event_type: "move_lead_failed",
        node_id: "n2",
        payload: { error: "Informe o motivo da perda.", codigo: "lost_reason_required" },
        idempotency_key: "n2:0:falha",
      },
    ]);
  });

  it("falha ao registrar o rastro não derruba o tick", async () => {
    const c = cenario(true);

    const resumo = await runFollowupTick(c.deps);

    expect(resumo.failed).toBe(0);
    expect(resumo.advanced).toBe(1);
    expect(c.patches[0]).toMatchObject({ current_node_id: "fim" });
    expect(c.eventos.map((e) => e.event_type)).toEqual(["node_advanced"]);
  });
});
