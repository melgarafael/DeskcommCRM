import { describe, expect, it } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { ORIGEM_DA_PLANILHA } from "@/lib/leads/planilha";
import type { EnabledFollowupAgent, FollowupGateDb } from "./agent-followup-gate";
import { triggerConfigSchema } from "./api-schemas";
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
/** Funil do card e funil que o fluxo pede — dois ids distintos, como na conta real. */
const FUNIL_DO_CARD = "b1000000-0000-4000-8000-000000000001";
const FUNIL_DO_FLUXO = "b1000000-0000-4000-8000-000000000002";

interface Registro {
  contatoConsultado: number;
  enrollments: unknown[];
  eventos: Array<{ event_type: string; payload: Record<string, unknown>; idempotency_key: string }>;
}

function fakeDb(opts: {
  pointers?: PointerDeLead[];
  contato?: string | null;
  pipelineId?: string | null;
  tags?: string[];
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
    async carregaCartaoDoNegocio() {
      opts.registro.contatoConsultado++;
      return {
        contactId: opts.contato === undefined ? CONTATO : opts.contato,
        pipelineId: opts.pipelineId === undefined ? FUNIL_DO_CARD : opts.pipelineId,
        tags: opts.tags ?? [],
      };
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

/**
 * Doc 301 = B (#4319): a IA no modo ASSISTIDO não inscreve o contato numa
 * sequência — sequência fala com o cliente. A mesma linha SEM a marca é o
 * controle: ela inscreve, então o zero de cima não é fixture morta.
 */
describe("aplicaGatilhoDeLead — a IA no modo assistido (doc 301 = B)", () => {
  const MARCA = { actor_type: "ai_agent", actor_id: "ag-1", actor_operation_mode: "assisted" };

  it("com a marca do assistido (negócio novo): não inscreve e conta o que ficou parado", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeLead(
      { db: fakeDb({ pointers: [pointerArmado], pedeAgente: false, registro: reg }), gateDb: fakeGate([]), clock: CLOCK },
      evento({ metadata: MARCA }),
    );
    expect(s.enrolled).toBe(0);
    expect(s.parados_no_assistido).toBe(1);
    expect(reg.enrollments).toHaveLength(0);
  });

  it("a marca HERDADA (regra que rodou por causa da IA) também segura", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeLead(
      { db: fakeDb({ pointers: [pointerArmado], pedeAgente: false, registro: reg }), gateDb: fakeGate([]), clock: CLOCK },
      evento({ metadata: { actor_type: "webhook_source", actor_id: "rule-1", actor_operation_mode: "assisted" } }),
    );
    expect(s.parados_no_assistido).toBe(1);
    expect(reg.enrollments).toHaveLength(0);
  });

  it("CONTROLE: a mesma linha sem a marca inscreve", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeLead(
      { db: fakeDb({ pointers: [pointerArmado], pedeAgente: false, registro: reg }), gateDb: fakeGate([]), clock: CLOCK },
      evento({ metadata: { actor_type: "ai_agent", actor_id: "ag-1" } }),
    );
    expect(s.enrolled).toBe(1);
    expect(s.parados_no_assistido).toBeUndefined();
  });
});

/**
 * #4587 — O FILTRO DO CARD: FUNIL E ETIQUETA.
 *
 * O defeito medido: `lead_created` valia para qualquer card novo de qualquer
 * funil. Como só existe UM fluxo vivo por contato
 * (`idx_followup_enrollments_one_live`), o card aberto no funil errado
 * inscrevia o contato no fluxo errado — e essa inscrição bloqueava a do fluxo
 * certo (23505 → skip). Os quatro casos abaixo são os quatro lados do filtro,
 * e o último é o contrato de compatibilidade: sem filtro, NADA mudou.
 */
describe("aplicaGatilhoDeLead — o filtro por funil e por etiqueta (#4587)", () => {
  const comFiltro = (filtro: PointerDeLead["filtro"]): PointerDeLead => ({
    ...pointerArmado,
    filtro,
  });

  it("filtro por FUNIL: card nascido em outro funil não inscreve o contato", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeLead(
      {
        db: fakeDb({
          pointers: [comFiltro({ pipelineId: FUNIL_DO_FLUXO })],
          pipelineId: FUNIL_DO_CARD,
          pedeAgente: false,
          registro: reg,
        }),
        gateDb: fakeGate([]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(s.enrolled).toBe(0);
    expect(s.fora_do_filtro).toBe(1);
    expect(reg.enrollments).toHaveLength(0);
  });

  it("filtro por ETIQUETA: card sem a etiqueta não inscreve o contato", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeLead(
      {
        db: fakeDb({
          pointers: [comFiltro({ tag: "vip" })],
          tags: ["lead-frio"],
          pedeAgente: false,
          registro: reg,
        }),
        gateDb: fakeGate([]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(s.enrolled).toBe(0);
    expect(s.fora_do_filtro).toBe(1);
    expect(reg.enrollments).toHaveLength(0);
  });

  it("card que CASA com funil e etiqueta inscreve — e a caixa da etiqueta não decide", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeLead(
      {
        db: fakeDb({
          pointers: [comFiltro({ pipelineId: FUNIL_DO_CARD, tag: "VIP" })],
          pipelineId: FUNIL_DO_CARD,
          tags: ["vip"],
          pedeAgente: false,
          registro: reg,
        }),
        gateDb: fakeGate([]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(s.enrolled).toBe(1);
    expect(s.fora_do_filtro).toBeUndefined();
    expect(reg.enrollments).toHaveLength(1);
  });

  it("SEM filtro, qualquer card inscreve — o comportamento de sempre", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeLead(
      {
        db: fakeDb({ pointers: [pointerArmado], pipelineId: FUNIL_DO_CARD, tags: [], pedeAgente: false, registro: reg }),
        gateDb: fakeGate([]),
        clock: CLOCK,
      },
      evento(),
    );
    expect(s.enrolled).toBe(1);
    expect(s.fora_do_filtro).toBeUndefined();
    expect(reg.enrollments).toHaveLength(1);
  });

  it("o fio aceita os dois campos e continua aceitando o params ausente", () => {
    expect(
      triggerConfigSchema.safeParse({
        kind: "lead_created",
        params: { pipeline_id: FUNIL_DO_FLUXO, tag: "vip" },
      }).success,
    ).toBe(true);
    expect(triggerConfigSchema.safeParse({ kind: "lead_created" }).success).toBe(true);
    expect(
      triggerConfigSchema.safeParse({ kind: "lead_created", params: { funil: "x" } }).success,
    ).toBe(false);
  });
});
