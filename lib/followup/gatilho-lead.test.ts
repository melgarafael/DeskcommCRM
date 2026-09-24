import { describe, expect, it } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { ORIGEM_DA_PLANILHA } from "@/lib/leads/planilha";
import type { EnabledFollowupAgent, FollowupGateDb } from "./agent-followup-gate";
import {
  EVENTO_DE_LEAD_CRIADO,
  aplicaGatilhoDeLead,
  type GatilhoLeadDb,
  type PointerDeLead,
} from "./gatilho-lead";

const ORG = "11111111-1111-1111-1111-111111111111";
const POINTER = "22222222-2222-2222-2222-222222222222";
const AGENT = "33333333-3333-3333-3333-333333333333";
const NEGOCIO = "44444444-4444-4444-4444-444444444444";
const CONTATO = "55555555-5555-5555-5555-555555555555";
const VERSION = "99999999-9999-9999-9999-999999999999";
const ENROLLMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENTO = "e0000000-0000-4000-8000-000000000001";

interface Registro {
  contatoConsultado: number;
  enrollments: unknown[];
  eventos: Array<{ event_type: string; payload: Record<string, unknown>; idempotency_key: string }>;
}

function fakeDb(opts: {
  pointers?: PointerDeLead[];
  contato?: string | null;
  noDeGatilho?: string | null;
  pedeAgente?: boolean;
  jaVivo?: boolean;
  stale?: boolean;
  registro: Registro;
}): GatilhoLeadDb {
  return {
    async carregaPointersDeLead() {
      return opts.pointers ?? [];
    },
    async carregaContatoDoNegocio() {
      opts.registro.contatoConsultado++;
      return opts.contato === undefined ? CONTATO : opts.contato;
    },
    async carregaNoDeGatilho() {
      if (opts.noDeGatilho === null) return null;
      return { id: opts.noDeGatilho ?? "t1", pedeAgente: opts.pedeAgente ?? true };
    },
    async insereEnrollment(input) {
      if (opts.stale) return { inserted: false, id: null, reason: "stale_origin" };
      if (opts.jaVivo) return { inserted: false, id: null };
      opts.registro.enrollments.push(input);
      return { inserted: true, id: ENROLLMENT };
    },
    async insereEventoDoEnrollment(evento) {
      opts.registro.eventos.push({
        event_type: evento.event_type,
        payload: evento.payload,
        idempotency_key: evento.idempotency_key,
      });
    },
  };
}

function fakeGate(agentes: EnabledFollowupAgent[]): FollowupGateDb {
  return {
    async loadEnabledPublishedFollowupAgents() {
      return agentes;
    },
  };
}

function registro(): Registro {
  return { contatoConsultado: 0, enrollments: [], eventos: [] };
}

function evento(over: Partial<EventRow> = {}): EventRow {
  return {
    id: EVENTO,
    organization_id: ORG,
    event_type: EVENTO_DE_LEAD_CRIADO,
    entity_kind: "crm_lead",
    entity_id: NEGOCIO,
    payload: {},
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...over,
  };
}

const pointerArmado: PointerDeLead = {
  id: POINTER,
  organization_id: ORG,
  active_version_id: VERSION,
};

const CLOCK = () => new Date("2026-09-22T15:00:00.000Z");

describe("aplicaGatilhoDeLead — o que não dispara", () => {
  it("outro evento não é reconhecido", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeLead(
      { db: fakeDb({ pointers: [pointerArmado], registro: reg }), gateDb: fakeGate([]), clock: CLOCK },
      evento({ event_type: "lead.stage_changed" }),
    );
    expect(s.matched).toBe(false);
    expect(reg.enrollments).toHaveLength(0);
    expect(reg.contatoConsultado).toBe(0);
  });

  it("lead.created com entity_kind legado não arma — o motor de automação já filtra por crm_lead", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeLead(
      { db: fakeDb({ pointers: [pointerArmado], registro: reg }), gateDb: fakeGate([]), clock: CLOCK },
      evento({ entity_kind: "lead" }),
    );
    expect(s.matched).toBe(false);
    expect(reg.contatoConsultado).toBe(0);
  });

  it("negócio que entrou por planilha não inscreve — importação não vira disparo em massa", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeLead(
      {
        db: fakeDb({ pointers: [pointerArmado], pedeAgente: false, registro: reg }),
        gateDb: fakeGate([]),
        clock: CLOCK,
      },
      evento({ metadata: { via: ORIGEM_DA_PLANILHA } }),
    );
    expect(s.vindos_de_planilha).toBe(1);
    expect(s.enrolled).toBe(0);
    expect(reg.enrollments).toHaveLength(0);
    expect(reg.contatoConsultado).toBe(0);
  });

  it("sem fluxo armado, não consulta o negócio", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeLead(
      { db: fakeDb({ pointers: [], registro: reg }), gateDb: fakeGate([]), clock: CLOCK },
      evento(),
    );
    expect(s.matched).toBe(true);
    expect(s.pointers_armados).toBe(0);
    expect(reg.contatoConsultado).toBe(0);
  });
});

describe("aplicaGatilhoDeLead — o enrollment", () => {
  it("grafo que pede IA sem agente publicado não enrolla", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeLead(
      { db: fakeDb({ pointers: [pointerArmado], registro: reg }), gateDb: fakeGate([]), clock: CLOCK },
      evento(),
    );
    expect(s.pointers_barrados_pelo_gate).toBe(1);
    expect(s.enrolled).toBe(0);
  });

  it("texto fixo enrolla sem agente", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeLead(
      {
        db: fakeDb({ pointers: [pointerArmado], pedeAgente: false, registro: reg }),
        gateDb: fakeGate([]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(s.enrolled).toBe(1);
    expect(reg.enrollments[0]).toMatchObject({ agent_id: null, contact_id: CONTATO, current_node_id: "t1" });
    expect(reg.enrollments[0]).not.toHaveProperty("next_eval_at");
  });

  it("grava proveniência pela linha do event_log", async () => {
    const reg = registro();
    await aplicaGatilhoDeLead(
      {
        db: fakeDb({ pointers: [pointerArmado], registro: reg }),
        gateDb: fakeGate([{ agentId: AGENT, pointerIds: [POINTER] }]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(reg.eventos).toEqual([
      {
        event_type: "enrolled_by_lead_created",
        payload: { lead_id: NEGOCIO, event_log_id: EVENTO },
        idempotency_key: `gatilho-lead:${EVENTO}`,
      },
    ]);
  });

  it("contato já vivo em outro fluxo é skip, sem proveniência", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeLead(
      {
        db: fakeDb({ pointers: [pointerArmado], jaVivo: true, registro: reg }),
        gateDb: fakeGate([{ agentId: AGENT, pointerIds: [POINTER] }]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(s.skipped_existing).toBe(1);
    expect(reg.eventos).toHaveLength(0);
  });

  it("origem obsoleta é contada à parte de já-vivo", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeLead(
      {
        db: fakeDb({ pointers: [pointerArmado], stale: true, registro: reg }),
        gateDb: fakeGate([{ agentId: AGENT, pointerIds: [POINTER] }]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(s.skipped_stale_origin).toBe(1);
    expect(s.skipped_existing).toBe(0);
  });

  it("negócio sem contato é contado", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeLead(
      {
        db: fakeDb({ pointers: [pointerArmado], contato: null, registro: reg }),
        gateDb: fakeGate([{ agentId: AGENT, pointerIds: [POINTER] }]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(s.sem_contato).toBe(1);
    expect(s.enrolled).toBe(0);
  });
});
