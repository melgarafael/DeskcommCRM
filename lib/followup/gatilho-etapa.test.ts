import { describe, expect, it } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";
import type { EnabledFollowupAgent, FollowupGateDb } from "./agent-followup-gate";
import {
  EVENTO_DE_ETAPA,
  aplicaGatilhoDeEtapa,
  type GatilhoEtapaDb,
  type PointerDeEtapa,
} from "./gatilho-etapa";

/**
 * A DECISÃO do gatilho de etapa, isolada do banco. O que este arquivo vigia é
 * o que o produtor faz com um evento: quando ignora, quando consulta, quando
 * enrolla e o que grava de proveniência. As garantias que só o Postgres pode
 * dar — o índice `idx_followup_enrollments_one_live`, o gate contra
 * `ai_agent_versions` real — vivem em `tests/invariants/followup-gatilho-etapa.test.ts`,
 * porque um fake que devolve `inserted:false` prova apenas que o código lê a
 * própria fixture.
 */

const ORG = "11111111-1111-1111-1111-111111111111";
const POINTER = "22222222-2222-2222-2222-222222222222";
const AGENT = "33333333-3333-3333-3333-333333333333";
const NEGOCIO = "44444444-4444-4444-4444-444444444444";
const CONTATO = "55555555-5555-5555-5555-555555555555";
const ETAPA_DESTINO = "66666666-6666-6666-6666-666666666666";
const ETAPA_ORIGEM = "77777777-7777-7777-7777-777777777777";
const OUTRA_ETAPA = "88888888-8888-8888-8888-888888888888";
const VERSION = "99999999-9999-9999-9999-999999999999";
const ENROLLMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

interface Registro {
  contatoConsultado: number;
  enrollments: unknown[];
  eventos: Array<{ event_type: string; payload: Record<string, unknown>; idempotency_key: string }>;
}

function fakeDb(opts: {
  pointers?: PointerDeEtapa[];
  contato?: string | null;
  noDeGatilho?: string | null;
  jaVivo?: boolean;
  registro: Registro;
}): GatilhoEtapaDb {
  return {
    async carregaPointersDeEtapa() {
      return opts.pointers ?? [];
    },
    async carregaContatoDoNegocio() {
      opts.registro.contatoConsultado++;
      return opts.contato === undefined ? CONTATO : opts.contato;
    },
    async carregaNoDeGatilho() {
      return opts.noDeGatilho === undefined ? "t1" : opts.noDeGatilho;
    },
    async insereEnrollment(input) {
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
    id: "e0000000-0000-4000-8000-000000000001",
    organization_id: ORG,
    event_type: EVENTO_DE_ETAPA,
    entity_kind: "crm_lead",
    entity_id: NEGOCIO,
    payload: { from_stage_id: ETAPA_ORIGEM, to_stage_id: ETAPA_DESTINO },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...over,
  };
}

const pointerArmado: PointerDeEtapa = {
  id: POINTER,
  organization_id: ORG,
  active_version_id: VERSION,
  stage_id: ETAPA_DESTINO,
};

const CLOCK = () => new Date("2026-08-10T12:00:00.000Z");

describe("aplicaGatilhoDeEtapa — o que NÃO dispara", () => {
  it("evento de outro tipo não é reconhecido", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeEtapa(
      { db: fakeDb({ pointers: [pointerArmado], registro: reg }), gateDb: fakeGate([]), clock: CLOCK },
      evento({ event_type: "lead.created" }),
    );
    expect(s.matched).toBe(false);
    expect(reg.enrollments).toHaveLength(0);
  });

  it("evento sem etapa de destino não é reconhecido (payload que não descreve o fato)", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeEtapa(
      { db: fakeDb({ pointers: [pointerArmado], registro: reg }), gateDb: fakeGate([]), clock: CLOCK },
      evento({ payload: { from_stage_id: ETAPA_ORIGEM } }),
    );
    expect(s.matched).toBe(false);
  });

  it("evento sem o negócio (entity_id nulo) não é reconhecido", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeEtapa(
      { db: fakeDb({ pointers: [pointerArmado], registro: reg }), gateDb: fakeGate([]), clock: CLOCK },
      evento({ entity_id: null }),
    );
    expect(s.matched).toBe(false);
  });

  it("pointer armado para OUTRA etapa não dispara", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeEtapa(
      {
        db: fakeDb({ pointers: [{ ...pointerArmado, stage_id: OUTRA_ETAPA }], registro: reg }),
        gateDb: fakeGate([{ agentId: AGENT, pointerIds: [POINTER] }]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(s.matched).toBe(true);
    expect(s.pointers_armados).toBe(0);
    expect(s.enrolled).toBe(0);
  });

  it("sem fluxo armado, NÃO vai ao banco atrás do contato — a maioria dos movimentos de card cai aqui", async () => {
    const reg = registro();
    await aplicaGatilhoDeEtapa(
      { db: fakeDb({ pointers: [], registro: reg }), gateDb: fakeGate([]), clock: CLOCK },
      evento(),
    );
    expect(reg.contatoConsultado).toBe(0);
  });
});

describe("aplicaGatilhoDeEtapa — o gate do agente", () => {
  it("nenhum agente publicado armando o fluxo → 0 enrollments, contado como barrado", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeEtapa(
      { db: fakeDb({ pointers: [pointerArmado], registro: reg }), gateDb: fakeGate([]), clock: CLOCK },
      evento(),
    );
    expect(s.pointers_barrados_pelo_gate).toBe(1);
    expect(s.enrolled).toBe(0);
    expect(reg.enrollments).toHaveLength(0);
  });

  it("agente que arma OUTRO fluxo não libera este", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeEtapa(
      {
        db: fakeDb({ pointers: [pointerArmado], registro: reg }),
        gateDb: fakeGate([{ agentId: AGENT, pointerIds: ["outro-pointer"] }]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(s.pointers_barrados_pelo_gate).toBe(1);
    expect(s.enrolled).toBe(0);
  });
});

describe("aplicaGatilhoDeEtapa — o enrollment que nasce", () => {
  // ⚠️ `next_eval_at` NÃO aparece no objeto esperado, e a ausência é o
  // contrato: desde a migration 0147 o produtor OMITE o campo para o
  // `default now()` do BANCO decidir — gravar o "agora" do processo produz um
  // instante que ainda é futuro para o claim, e o enrollment perde um tick
  // inteiro. Se este campo voltar a aparecer aqui, o defeito voltou.
  it("fluxo armado e liberado → 1 enrollment no nó de gatilho, com o agente pinado", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeEtapa(
      {
        db: fakeDb({ pointers: [pointerArmado], registro: reg }),
        gateDb: fakeGate([{ agentId: AGENT, pointerIds: [POINTER] }]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(s.enrolled).toBe(1);
    expect(reg.enrollments).toEqual([
      {
        event_id: evento().id,
        organization_id: ORG,
        pointer_id: POINTER,
        version_id: VERSION,
        contact_id: CONTATO,
        current_node_id: "t1",
        agent_id: AGENT,
      },
    ]);
  });

  it("grava a proveniência: de que negócio, de qual etapa para qual, e por qual linha do event_log", async () => {
    const reg = registro();
    await aplicaGatilhoDeEtapa(
      {
        db: fakeDb({ pointers: [pointerArmado], registro: reg }),
        gateDb: fakeGate([{ agentId: AGENT, pointerIds: [POINTER] }]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(reg.eventos).toEqual([
      {
        event_type: "enrolled_by_stage_change",
        payload: {
          lead_id: NEGOCIO,
          from_stage_id: ETAPA_ORIGEM,
          to_stage_id: ETAPA_DESTINO,
          event_log_id: "e0000000-0000-4000-8000-000000000001",
        },
        idempotency_key: "gatilho-etapa:e0000000-0000-4000-8000-000000000001",
      },
    ]);
  });

  it("contato já vivo em algum fluxo → skip silencioso, e SEM linha de proveniência órfã", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeEtapa(
      {
        db: fakeDb({ pointers: [pointerArmado], jaVivo: true, registro: reg }),
        gateDb: fakeGate([{ agentId: AGENT, pointerIds: [POINTER] }]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(s.enrolled).toBe(0);
    expect(s.skipped_existing).toBe(1);
    expect(reg.eventos).toHaveLength(0);
  });

  it("negócio sem contato é CONTADO, não engolido — não há a quem escrever", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeEtapa(
      {
        db: fakeDb({ pointers: [pointerArmado], contato: null, registro: reg }),
        gateDb: fakeGate([{ agentId: AGENT, pointerIds: [POINTER] }]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(s.sem_contato).toBe(1);
    expect(s.enrolled).toBe(0);
    expect(reg.enrollments).toHaveLength(0);
  });

  it("dois fluxos armados na MESMA etapa: cada um é avaliado pelo gate", async () => {
    const reg = registro();
    const outro = { ...pointerArmado, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    const s = await aplicaGatilhoDeEtapa(
      {
        db: fakeDb({ pointers: [pointerArmado, outro], registro: reg }),
        gateDb: fakeGate([{ agentId: AGENT, pointerIds: [POINTER] }]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(s.pointers_armados).toBe(2);
    expect(s.enrolled).toBe(1);
    expect(s.pointers_barrados_pelo_gate).toBe(1);
  });
});
