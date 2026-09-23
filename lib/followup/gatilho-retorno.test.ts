import { describe, expect, it } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";
import type { EnabledFollowupAgent, FollowupGateDb } from "./agent-followup-gate";
import {
  EVENTO_DE_RETORNO,
  aplicaGatilhoDeRetorno,
  type EstadoDaConversaDeRetorno,
  type GatilhoRetornoDb,
  type PointerDeRetorno,
} from "./gatilho-retorno";

const ORG = "11111111-1111-1111-1111-111111111111";
const POINTER = "22222222-2222-2222-2222-222222222222";
const AGENT = "33333333-3333-3333-3333-333333333333";
const CONTATO = "55555555-5555-5555-5555-555555555555";
const CONVERSA = "66666666-6666-6666-6666-666666666666";
const MENSAGEM = "77777777-7777-7777-7777-777777777777";
const VERSION = "99999999-9999-9999-9999-999999999999";
const ENROLLMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const AGORA = new Date("2026-09-20T12:00:00.000Z");
const CLOCK = () => AGORA;

interface Registro {
  enrollments: unknown[];
  eventos: Array<{ event_type: string; payload: Record<string, unknown>; idempotency_key: string }>;
}

function fakeDb(opts: {
  pointers?: PointerDeRetorno[];
  anterior?: Date | null;
  estado?: EstadoDaConversaDeRetorno | null;
  vivo?: { pointer_id: string } | null;
  noDeGatilho?: string | null;
  pedeAgente?: boolean;
  jaVivoInsert?: boolean;
  registro: Registro;
}): GatilhoRetornoDb {
  return {
    async carregaPointersDeRetorno() {
      return opts.pointers ?? [];
    },
    async carregaInboundAnterior() {
      return opts.anterior === undefined ? new Date(AGORA.getTime() - 2 * 24 * 60 * 60_000) : opts.anterior;
    },
    async carregaEstadoDaConversa() {
      return (
        opts.estado ?? {
          is_group: false,
          is_blocked: false,
          force_human: false,
          assignee_kind: "ai",
          bot_silenced_until: null,
          tags: [],
        }
      );
    },
    async carregaEnrollmentVivo() {
      return opts.vivo ?? null;
    },
    async carregaNoDeGatilho() {
      if (opts.noDeGatilho === null) return null;
      return { id: opts.noDeGatilho ?? "t1", pedeAgente: opts.pedeAgente ?? true };
    },
    async insereEnrollment(input) {
      if (opts.jaVivoInsert) return { inserted: false, id: null };
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
  return { enrollments: [], eventos: [] };
}

function evento(over: Partial<EventRow> = {}): EventRow {
  return {
    id: "e0000000-0000-4000-8000-000000000001",
    organization_id: ORG,
    event_type: EVENTO_DE_RETORNO,
    entity_kind: "message",
    entity_id: MENSAGEM,
    payload: { contact_id: CONTATO, conversation_id: CONVERSA, message_id: MENSAGEM },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...over,
  };
}

const pointerArmado: PointerDeRetorno = {
  id: POINTER,
  organization_id: ORG,
  active_version_id: VERSION,
  threshold_minutes: 1440,
  segments: [],
};

describe("aplicaGatilhoDeRetorno — o que NÃO dispara", () => {
  it("evento de outro tipo não é reconhecido", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeRetorno(
      {
        db: fakeDb({ pointers: [pointerArmado], registro: reg }),
        gateDb: fakeGate([]),
        clock: CLOCK,
      },
      evento({ event_type: "lead.created" }),
    );
    expect(s.matched).toBe(false);
    expect(reg.enrollments).toHaveLength(0);
  });

  it("primeiro inbound da vida não é retorno", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeRetorno(
      {
        db: fakeDb({
          pointers: [pointerArmado],
          anterior: null,
          registro: reg,
        }),
        gateDb: fakeGate([{ agentId: AGENT, pointerIds: [POINTER] }]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(s.matched).toBe(true);
    expect(s.skipped_gap).toBe(1);
    expect(reg.enrollments).toHaveLength(0);
  });

  it("buraco abaixo do limiar não dispara", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeRetorno(
      {
        db: fakeDb({
          pointers: [pointerArmado],
          anterior: new Date(AGORA.getTime() - 1439 * 60_000),
          registro: reg,
        }),
        gateDb: fakeGate([{ agentId: AGENT, pointerIds: [POINTER] }]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(s.enrolled).toBe(0);
    expect(s.skipped_gap).toBe(1);
  });

  it("humano no comando não dispara", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeRetorno(
      {
        db: fakeDb({
          pointers: [pointerArmado],
          estado: {
            is_group: false,
            is_blocked: false,
            force_human: true,
            assignee_kind: "ai",
            bot_silenced_until: null,
            tags: [],
          },
          registro: reg,
        }),
        gateDb: fakeGate([{ agentId: AGENT, pointerIds: [POINTER] }]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(s.skipped_humano).toBe(1);
    expect(reg.enrollments).toHaveLength(0);
  });

  it("outro fluxo vivo ocupa o único slot", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeRetorno(
      {
        db: fakeDb({
          pointers: [pointerArmado],
          vivo: { pointer_id: "outro-pointer" },
          registro: reg,
        }),
        gateDb: fakeGate([{ agentId: AGENT, pointerIds: [POINTER] }]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(s.skipped_existing).toBe(1);
    expect(reg.enrollments).toHaveLength(0);
  });
});

describe("aplicaGatilhoDeRetorno — o que dispara", () => {
  it("enrolla com proveniência e omite next_eval_at", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeRetorno(
      {
        db: fakeDb({ pointers: [pointerArmado], registro: reg }),
        gateDb: fakeGate([{ agentId: AGENT, pointerIds: [POINTER] }]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(s.enrolled).toBe(1);
    expect(reg.enrollments[0]).not.toHaveProperty("next_eval_at");
    expect(reg.eventos[0]?.event_type).toBe("enrolled_by_inbound_after_silence");
    expect(reg.eventos[0]?.payload.threshold_minutes).toBe(1440);
  });

  it("sem agente, grafo só de texto fixo enrolla com agent_id nulo", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeRetorno(
      {
        db: fakeDb({ pointers: [pointerArmado], pedeAgente: false, registro: reg }),
        gateDb: fakeGate([]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(s.enrolled).toBe(1);
    expect(s.pointers_barrados_pelo_gate).toBe(0);
    expect(reg.enrollments[0]).toMatchObject({ agent_id: null });
  });

  it("sem agente, grafo que pede IA é barrado", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeRetorno(
      {
        db: fakeDb({ pointers: [pointerArmado], pedeAgente: true, registro: reg }),
        gateDb: fakeGate([]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(s.enrolled).toBe(0);
    expect(s.pointers_barrados_pelo_gate).toBe(1);
    expect(reg.enrollments).toHaveLength(0);
  });
});
