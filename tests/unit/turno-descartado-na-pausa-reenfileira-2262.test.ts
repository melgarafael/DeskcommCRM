/**
 * #2262 — A RETOMADA REENFILEIRA o passo que a PAUSA descartou.
 *
 * ## Os dois lados do mesmo defeito
 *
 * Durante a pausa (`paused_handoff`), o turno de envio que roda cai no guard da
 * #1913 (`lib/agent-engine/agent/followup-turn.ts`) e é descartado. Antes desta
 * mudança ele saía SEM gravar nada — o último evento da estadia seguia sendo o
 * `turn_enqueued` daquele job.
 *
 * A retomada (`ai.handoff_resolved`, `lib/followup/reactivity.ts`) devolve
 * `status='active'` e um `next_eval_at`, e o primeiro tick reavalia o nó. O
 * motor calcula `actionEnqueued = waitElapsed && !turnoDaAcaoDescartado(...)`
 * (`lib/followup/engine.ts`):
 *
 * - SEM rastro → `true`, o motor lê "turno ainda em voo", só RECHECA e não
 *   enfileira nada. A sequência fica parada no nó até o dead-man marcá-la
 *   `dead` com `action_turn_never_completed` — motivo falso, porque o worker
 *   estava vivo e quem descartou foi a pausa. **Este é o caso 1, o "antes".**
 * - COM `turn_discarded` → `false`, e o nó de `action` enfileira UM turno novo
 *   (`enqueue_turn`) com a chave do passo seguinte. **Caso 2, o "depois".**
 *
 * O lado do descarte (quem grava o rastro e em quais condições) é medido em
 * `tests/unit/followup-turn-so-sai-com-inscricao-viva.test.ts`.
 *
 * Roda sem Postgres: o adaptador é um dublê de `AdminClient`, mesmo desenho de
 * `tests/unit/nos-de-acao-do-followup-2065.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  runFollowupTick,
  type AdminClient,
  type FollowupJobRequest,
  type TickDeps,
} from "@/lib/followup/engine";
import { flowGraphSchema } from "@/lib/followup/graph-schema";
import { rechecksOciososDaAcao, type EnrollmentEventRef, type EnrollmentRow } from "@/lib/followup/node-handlers";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";

/** Inscrição já RETOMADA: `active` de novo, parada no nó de `action`. */
function enrollmentRetomado(): EnrollmentRow {
  return {
    id: "e1",
    organization_id: ORG,
    pointer_id: "p1",
    version_id: "v1",
    contact_id: CONTATO,
    conversation_id: null,
    current_node_id: "a1",
    status: "active",
    next_eval_at: new Date().toISOString(),
    claimed_until: null,
    attempts: 0,
    max_attempts: 3,
    last_error: null,
    // A estadia já enfileirou um turno: `a1:1` é a chave daquele passo.
    steps_taken: 2,
    outcome: null,
    cancel_reason: null,
    started_at: new Date().toISOString(),
    completed_at: null,
    updated_at: new Date().toISOString(),
  };
}

const GRAFO = flowGraphSchema.parse({
  nodes: [
    { id: "n1", type: "trigger", label: "gatilho", position: { x: 0, y: 0 }, config: {} },
    {
      id: "a1",
      type: "action",
      label: "envio",
      position: { x: 120, y: 0 },
      config: { mode: "text", body: "Olá!" },
    },
    {
      id: "fim",
      type: "end",
      label: "fim",
      position: { x: 240, y: 0 },
      config: { outcome: "converted" },
    },
  ],
  edges: [
    { id: "e1", source: "n1", target: "a1", condition: { type: "always" } },
    { id: "e2", source: "a1", target: "fim", condition: { type: "always" } },
  ],
});

/** O turno que a PAUSA descartou — o evento que sempre existiu. */
const TURNO_ENFILEIRADO: EnrollmentEventRef = {
  node_id: "a1",
  idempotency_key: "a1:1",
  event_type: "turn_enqueued",
  payload: { purpose: "send_message" },
};

/** O rastro que faltava (#2262) — mesma chave `…:descartado` da migration 0501. */
const TURNO_DESCARTADO: EnrollmentEventRef = {
  node_id: "a1",
  idempotency_key: "a1:1:descartado",
  event_type: "turn_discarded",
  payload: { motivo: "inscricao_pausada" },
};

function cenario(eventos: EnrollmentEventRef[]) {
  const jobs: FollowupJobRequest[] = [];
  const patches: Array<Record<string, unknown>> = [];
  const eventosGravados: string[] = [];

  const db: AdminClient = {
    async claimDueEnrollments() {
      return [enrollmentRetomado()];
    },
    async loadFlowGraph() {
      return GRAFO;
    },
    async loadLeadFacts() {
      return { lead_stage: "etapa-a", tags: [], contact_name: "Cliente", custom_fields: {} };
    },
    async loadEnrollmentEvents() {
      return eventos;
    },
    async insertEnrollmentEvent(event) {
      eventosGravados.push(event.event_type);
      return { inserted: true };
    },
    async updateEnrollment(_id, _org, patch) {
      patches.push(patch as Record<string, unknown>);
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
    clock: () => new Date("2026-10-04T12:00:00.000Z"),
    enqueueJob: async (job) => {
      jobs.push(job);
    },
  };

  return { deps, jobs, patches, eventosGravados };
}

describe("#2262 — turno descartado durante a pausa não é reenfileirado na retomada", () => {
  it("⭐ ANTES (sem o rastro): a retomada só recheca — nenhum turno novo sai, o passo fica parado", async () => {
    const c = cenario([TURNO_ENFILEIRADO]);

    const resumo = await runFollowupTick(c.deps);

    expect(resumo.failed, "o tick não deveria falhar").toBe(0);
    expect(resumo.dead, "o dead-man ainda não cobrou").toBe(0);
    // O defeito: o motor lê "turno em voo" e devolve `recheck` — scheduled
    // sobe, mas NENHUM job nasce, e o `action_sent` que fecharia o passo nunca
    // vem. É a sequência parada no nó.
    expect(c.jobs, "sem turn_discarded a retomada não reenfileira nada").toHaveLength(0);
    expect(c.eventosGravados).toEqual(["action_recheck"]);
    expect(c.patches[0]).toMatchObject({ current_node_id: "a1", status: "active" });
  });

  it("⭐ DEPOIS (com o rastro gravado pela pausa): a retomada enfileira UM turno novo de envio", async () => {
    const c = cenario([TURNO_ENFILEIRADO, TURNO_DESCARTADO]);

    const resumo = await runFollowupTick(c.deps);

    expect(resumo.failed).toBe(0);
    expect(resumo.scheduled).toBe(1);
    expect(c.jobs, "o rastro turn_discarded tem de virar um turno novo").toHaveLength(1);
    expect(c.jobs[0]?.payload.purpose).toBe("send_message");
    expect(c.jobs[0]?.payload.followup_enrollment_id).toBe("e1");
    expect(c.jobs[0]?.payload.node_id).toBe("a1");
    // A chave do passo NOVO (`a1:2`) é diferente da do descartado (`a1:1`):
    // a estadia avança, e um replay não enfileira a segunda vez.
    expect(c.eventosGravados).toEqual(["turn_enqueued"]);
    expect(c.patches[0]).toMatchObject({ current_node_id: "a1", status: "active" });
  });

  it("o rastro também ZERA o orçamento do dead-man — a retomada não nasce devendo rechecks", async () => {
    // `rechecksOciososDaAcao` para no `turn_discarded`: a ociosidade medida é
    // a DEPOIS do descarte. Sem isto, a retomada herdaria a dívida da estadia
    // anterior e o dead-man marcaria o passo `dead` com
    // `action_turn_never_completed` — motivo falso, porque o worker estava vivo.
    expect(rechecksOciososDaAcao([TURNO_ENFILEIRADO, TURNO_DESCARTADO], "a1")).toBe(0);
    // Controle: sem o rastro, o mesmo conjunto de eventos já vinha com dívida.
    expect(rechecksOciososDaAcao([TURNO_ENFILEIRADO], "a1")).toBe(1);
  });
});
