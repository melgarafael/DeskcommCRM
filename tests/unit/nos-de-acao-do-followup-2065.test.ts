/**
 * #2065 — nós de ACAO num fluxo de follow-up: "mover lead no funil" e
 * "editar lead (tag)".
 *
 * O que este arquivo mede, em ordem:
 *
 * 1. Um grafo com `move_lead` / `edit_lead_tag` É RECUSADO hoje (o
 *    `flowGraphSchema` é uma discriminated union fechada) e, com a mudança,
 *    parseia, avança e chama a escrita da casa — `moveLeadHandler` e a ação
 *    `add_tag`, os MESMOS caminhos que o board e o motor de automação usam.
 * 2. Controle A: um fluxo que só MANDA MENSAGEM (`trigger → action → end`)
 *    continua fazendo exatamente o que fazia: avança no gatilho e enfileira UM
 *    turno `send_message` com evento `turn_enqueued`.
 * 3. Controle B: um nó de tipo DESCONHECIDO (`campaign`, a "disparar
 *    campanha" que ficou fora desta fatia) não quebra o tick — cai no
 *    comportamento já medido: `loadFlowGraph` lança na validação do jsonb, o
 *    `runFollowupTick` captura, conta `failed` e reagenda com backoff.
 *
 * Roda sem Postgres: o adaptador é um dublê de `AdminClient`, mesmo desenho de
 * `tests/api/followup-cron-worker.test.ts`.
 */
import { describe, expect, it } from "vitest";

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

function enrollment(currentNodeId: string, extra: Partial<EnrollmentRow> = {}): EnrollmentRow {
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
    ...extra,
  };
}

/** Cenário: o claim drena `fila` (uma vez por tick), como o claim real. */
function cenario(grafo: unknown, fila: EnrollmentRow[]) {
  const eventos: Array<{ event_type: string; node_id: string; payload: Record<string, unknown> }> = [];
  const patches: Array<Record<string, unknown>> = [];
  const jobs: FollowupJobRequest[] = [];
  const chamadas: { mover?: unknown[]; editar?: unknown[] } = {};

  const db: AdminClient = {
    async claimDueEnrollments() {
      return fila.splice(0, fila.length);
    },
    async loadFlowGraph() {
      // É AQUI que o jsonb do fluxo é validado — mesmo caminho da produção
      // (`createSupabaseAdminClient.loadFlowGraph` faz `flowGraphSchema.parse`).
      return flowGraphSchema.parse(grafo);
    },
    async loadLeadFacts() {
      return { lead_stage: "etapa-a", tags: ["existe"], contact_name: "Cliente", custom_fields: {} };
    },
    async loadEnrollmentEvents() {
      return [];
    },
    async insertEnrollmentEvent(event) {
      eventos.push({ event_type: event.event_type, node_id: event.node_id, payload: event.payload });
      return { inserted: true };
    },
    async updateEnrollment(_id, _org, patch) {
      patches.push(patch as Record<string, unknown>);
    },
    async moverLeadNoFunil(item) {
      chamadas.mover = [item];
    },
    async editarTagDoLead(item) {
      chamadas.editar = [item];
    },
    // Obrigatórios na interface e não exercitados por estes cenários.
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

  return { deps, eventos, patches, jobs, chamadas, fila };
}

function grafo(...nos: Array<{ id: string; type: string; config: unknown }>): unknown {
  return {
    nodes: nos.map((n, i) => ({
      ...n,
      label: `nó ${n.id}`,
      position: { x: 100 * i, y: 0 },
    })),
    edges: nos.slice(0, -1).map((n, i) => ({
      id: `e-${n.id}-${nos[i + 1]!.id}`,
      source: n.id,
      target: nos[i + 1]!.id,
      condition: { type: "always" },
    })),
  };
}

const NO_TRIGGER = { id: "n1", type: "trigger", config: {} };
const NO_FIM = { id: "fim", type: "end", config: { outcome: "converted" } };

describe("nó mover lead no funil (#2065)", () => {
  it("parseia, avança e chama a escrita de etapa da casa — hoje a fatia é recusada", async () => {
    const c = cenario(
      grafo(NO_TRIGGER, { id: "n2", type: "move_lead", config: { stage_id: ETAPA } }, NO_FIM),
      [enrollment("n2")],
    );

    const resumo = await runFollowupTick(c.deps);

    expect(resumo.failed).toBe(0);
    expect(c.chamadas.mover).toHaveLength(1);
    expect(c.chamadas.mover?.[0]).toMatchObject({
      organization_id: ORG,
      contact_id: CONTATO,
      enrollment_id: "e1",
      config: { stage_id: ETAPA },
    });
    // O evento do passo é a trava de idempotência (replay não move 2x).
    expect(c.eventos).toEqual([
      { event_type: "node_advanced", node_id: "n2", payload: { next_node_id: "fim" } },
    ]);
    expect(c.patches[0]).toMatchObject({ current_node_id: "fim", steps_taken: 1, status: "active" });
    expect(resumo.advanced).toBe(1);
  });
});

describe("nó editar lead — tag (#2065)", () => {
  it("parseia, avança e chama a escrita de tag da casa — hoje a fatia é recusada", async () => {
    const c = cenario(
      grafo(NO_TRIGGER, { id: "n2", type: "edit_lead_tag", config: { tags: ["vip"] } }, NO_FIM),
      [enrollment("n2")],
    );

    const resumo = await runFollowupTick(c.deps);

    expect(resumo.failed).toBe(0);
    expect(c.chamadas.editar).toHaveLength(1);
    expect(c.chamadas.editar?.[0]).toMatchObject({
      organization_id: ORG,
      contact_id: CONTATO,
      enrollment_id: "e1",
      config: { tags: ["vip"] },
    });
    expect(c.eventos[0]?.event_type).toBe("node_advanced");
    expect(c.patches[0]).toMatchObject({ current_node_id: "fim", steps_taken: 1 });
    expect(resumo.advanced).toBe(1);
  });
});

describe("controle: fluxo que só manda mensagem continua idêntico", () => {
  it("trigger avança e o action enfileira UM turno send_message com evento turn_enqueued", async () => {
    const c = cenario(
      grafo(NO_TRIGGER, { id: "n2", type: "action", config: { mode: "text", body: "Olá!" } }, NO_FIM),
      [enrollment("n1")],
    );

    const primeiro = await runFollowupTick(c.deps);
    expect(primeiro).toMatchObject({ claimed: 1, advanced: 1, scheduled: 0, failed: 0 });
    expect(c.patches[0]).toMatchObject({ current_node_id: "n2", status: "active" });
    expect(c.jobs).toHaveLength(0);

    // Segundo tick: o enrollment está no action.
    c.fila.push(enrollment("n2", { steps_taken: 1 }));
    const segundo = await runFollowupTick(c.deps);

    expect(segundo.scheduled).toBe(1);
    expect(c.jobs).toHaveLength(1);
    expect(c.jobs[0]?.payload.purpose).toBe("send_message");
    expect(c.jobs[0]?.payload.fixed_body).toBe("Olá!");
    expect(c.eventos.map((e) => e.event_type)).toEqual(["node_advanced", "turn_enqueued"]);
    expect(c.eventos[1]).toMatchObject({ node_id: "n2", payload: { purpose: "send_message" } });
    expect(c.chamadas.mover).toBeUndefined();
    expect(c.chamadas.editar).toBeUndefined();
  });
});

describe("controle: nó de tipo desconhecido não quebra o fluxo", () => {
  it("cai no comportamento já medido: failed com backoff, sem crash e sem dead", async () => {
    const c = cenario(
      grafo(NO_TRIGGER, { id: "n2", type: "campaign", config: {} }, NO_FIM),
      [enrollment("n2")],
    );

    const resumo = await runFollowupTick(c.deps);

    expect(resumo).toMatchObject({ claimed: 1, failed: 1, dead: 0, advanced: 0 });
    expect(c.patches[0]).toMatchObject({ attempts: 1 });
    expect(String(c.patches[0]?.last_error ?? "").length).toBeGreaterThan(0);
    expect(c.chamadas.mover).toBeUndefined();
    expect(c.chamadas.editar).toBeUndefined();
  });
});
