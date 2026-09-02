import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HandlerCtx } from "@/lib/api/handlers/types";
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));

import { encerraDemanda } from "./encerramento";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const PIPELINE = "33333333-3333-4333-8333-333333333333";
const LEAD = "44444444-4444-4444-8444-444444444444";
const OPEN_STAGE = "55555555-5555-4555-8555-555555555555";
const WON_STAGE = "66666666-6666-4666-8666-666666666666";
const LOST_STAGE = "77777777-7777-4777-8777-777777777777";

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: "88888888-8888-4888-8888-888888888888" },
  requestId: "99999999-9999-4999-8999-999999999999",
};

type Row = Record<string, unknown>;

function makeDb({
  leads = [],
  stages = [],
}: {
  leads?: Row[];
  stages?: Row[];
} = {}) {
  const tables: Record<string, Row[]> = {
    crm_leads: leads,
    crm_stages: stages,
    crm_lead_activities: [],
  };
  const updates: Row[] = [];
  const rpcs: string[] = [];

  function from(table: string) {
    const filters: Array<[string, unknown]> = [];
    const orders: Array<[string, boolean]> = [];
    let limit: number | undefined;
    let patch: Row | undefined;
    let operation: "select" | "update" | "insert" = "select";
    let insertRow: Row | undefined;

    const builder = {
      select: () => {
        operation = "select";
        return builder;
      },
      update: (value: Row) => {
        operation = "update";
        patch = value;
        updates.push(value);
        return builder;
      },
      insert: (value: Row) => {
        operation = "insert";
        insertRow = value;
        return builder;
      },
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return builder;
      },
      order: (column: string, options?: { ascending?: boolean }) => {
        orders.push([column, options?.ascending ?? true]);
        return builder;
      },
      limit: (value: number) => {
        limit = value;
        return builder;
      },
      maybeSingle: async () => {
        const rows = [...(tables[table] ?? [])]
          .filter((row) => filters.every(([column, value]) => row[column] === value))
          .sort((a, b) => {
            for (const [column, ascending] of orders) {
              const diff = Number(a[column] ?? 0) - Number(b[column] ?? 0);
              if (diff !== 0) return ascending ? diff : -diff;
            }
            return 0;
          })
          .slice(0, limit);
        return { data: rows[0] ?? null, error: null };
      },
      then: async (resolve: (value: unknown) => unknown) => {
        if (operation === "update") {
          const rows = tables[table] ?? [];
          for (const row of rows) {
            if (filters.every(([column, value]) => row[column] === value)) {
              Object.assign(row, patch);
              const stage = stages.find((candidate) => candidate.id === row.stage_id);
              if (stage?.is_won === true) {
                row.status = "won";
                row.closed_at ??= "2026-08-20T00:00:00.000Z";
              } else if (stage?.is_lost === true) {
                row.status = "lost";
                row.closed_at ??= "2026-08-20T00:00:00.000Z";
              }
            }
          }
        } else if (operation === "insert" && insertRow) {
          (tables[table] ??= []).push(insertRow);
        }
        return resolve({ data: null, error: null });
      },
    };

    return builder;
  }

  return {
    client: { from, rpc: async (name: string) => (rpcs.push(name), { error: null }) },
    tables,
    updates,
    rpcs,
  };
}

function baseLead(overrides: Row = {}): Row {
  return {
    id: LEAD,
    organization_id: ORG,
    pipeline_id: PIPELINE,
    stage_id: OPEN_STAGE,
    status: "open",
    position_in_stage: 1000,
    contact_id: null,
    closed_at: null,
    lost_reason: null,
    value_cents: 1000,
    currency: "BRL",
    ...overrides,
  };
}

function baseStages(overrides: Row = {}) {
  return [
    { id: OPEN_STAGE, organization_id: ORG, pipeline_id: PIPELINE, is_won: false, is_lost: false, is_archived: false, position: 1, name: "Aberto" },
    { id: WON_STAGE, organization_id: ORG, pipeline_id: PIPELINE, is_won: true, is_lost: false, is_archived: false, position: 2, name: "Pago", ...overrides },
    { id: LOST_STAGE, organization_id: ORG, pipeline_id: PIPELINE, is_won: false, is_lost: true, is_archived: false, position: 3, name: "Perdido" },
  ];
}

describe("encerraDemanda", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retorna lost_reason_required antes de consultar o banco", async () => {
    const db = makeDb();

    await expect(
      encerraDemanda(db.client as never, ctx, { leadId: LEAD, desfecho: "lost", motivo: "  " }),
    ).rejects.toMatchObject({ code: "validation_failed", status: 422 });
    expect(db.updates).toEqual([]);
    expect(db.rpcs).toEqual([]);
  });

  it("não usa stage terminal arquivado", async () => {
    const db = makeDb({
      leads: [baseLead()],
      stages: baseStages({ is_archived: true }),
    });

    await expect(
      encerraDemanda(db.client as never, ctx, { leadId: LEAD, desfecho: "won" }),
    ).rejects.toMatchObject({ code: "pipeline_no_won_stage", status: 422 });
    expect(db.updates).toEqual([]);
  });

  // O `.order("position")` da consulta não tinha guarda: sabotado sozinho, os
  // sete casos ficavam verdes. Um funil com DUAS etapas de ganho é comum de
  // verdade — "Pago" e "Pago parcial", "Fechado" e "Fechado com desconto" —, e
  // sem ordem determinística o Postgres devolve qualquer uma das duas, o que faz
  // o MESMO negócio cair em etapas diferentes entre uma execução e a seguinte.
  // As etapas entram aqui na ordem INVERSA da posição de propósito: sem o
  // `.order`, o dublê preserva a ordem de inserção e a asserção pega a errada.
  it("entre duas etapas de ganho, escolhe a de menor posição — e não a primeira que o banco devolver", async () => {
    const SEGUNDA_GANHO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const db = makeDb({
      leads: [baseLead()],
      stages: [
        { id: OPEN_STAGE, organization_id: ORG, pipeline_id: PIPELINE, is_won: false, is_lost: false, is_archived: false, position: 1, name: "Aberto" },
        { id: SEGUNDA_GANHO, organization_id: ORG, pipeline_id: PIPELINE, is_won: true, is_lost: false, is_archived: false, position: 9, name: "Pago parcial" },
        { id: WON_STAGE, organization_id: ORG, pipeline_id: PIPELINE, is_won: true, is_lost: false, is_archived: false, position: 2, name: "Pago" },
      ],
    });

    await encerraDemanda(db.client as never, ctx, { leadId: LEAD, desfecho: "won" });

    expect(db.updates[0]).toMatchObject({ stage_id: WON_STAGE });
  });

  it("move para o fim da stage, preserva a fonte única de evento e fecha como ganho", async () => {
    const db = makeDb({
      leads: [
        baseLead(),
        baseLead({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", stage_id: WON_STAGE, position_in_stage: 4000, status: "won" }),
      ],
      stages: baseStages(),
    });

    const result = await encerraDemanda(db.client as never, ctx, { leadId: LEAD, desfecho: "won" });

    expect(result.lead).toMatchObject({ status: "won", stage_id: WON_STAGE, position_in_stage: 5000 });
    expect(db.updates[0]).toMatchObject({ stage_id: WON_STAGE, position_in_stage: 5000 });
    expect(db.rpcs).toEqual([]);
  });

  it("não alcança lead de outra organização", async () => {
    const db = makeDb({
      leads: [baseLead({ organization_id: OTHER_ORG })],
      stages: baseStages(),
    });

    await expect(
      encerraDemanda(db.client as never, ctx, { leadId: LEAD, desfecho: "won" }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(db.updates).toEqual([]);
  });

  it("é idempotente quando o lead já está ganho", async () => {
    const lead = baseLead({ status: "won", stage_id: WON_STAGE, closed_at: "2026-08-19T00:00:00.000Z" });
    const db = makeDb({ leads: [lead], stages: baseStages() });

    const result = await encerraDemanda(db.client as never, ctx, { leadId: LEAD, desfecho: "won" });

    expect(result).toMatchObject({ jaEstava: true, lead });
    expect(db.updates).toEqual([]);
    expect(db.rpcs).toEqual([]);
  });
});
