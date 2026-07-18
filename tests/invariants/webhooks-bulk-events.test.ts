import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import type { AuthUser } from "@/lib/auth/types";
import { runAutomationForEvent } from "@/lib/automation/engine";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { sql, lastLine } from "./gov-helpers";

/**
 * Final-review fixes (2026-07-18) — bulk Kanban ops (move/tag) só emitiam
 * eventos agregados (`lead.bulk_moved`/`lead.bulk_tagged`), nunca os eventos
 * por-lead que o motor de automação consome. E `automation.rule_executed`
 * nunca era auditado em runs falhas (spec §9).
 *
 * Namespace próprio ('ffffffff-') com org DEDICADA (slug 'gov-inv-bulkev') —
 * evita colidir com as automation_rules de outros arquivos (automation-engine
 * seeda R1-R6 em GOV_ORG/ORG_2 escutando lead.created/stage_changed/tag_added).
 *
 * `requireRole`/`createClient` são mockados (Route Handler real não roda sob
 * Next middleware neste harness); `FakeQB` traduz o shape que o handler e o
 * engine usam pra SQL cru via `sql()` (docker exec psql), igual aos irmãos
 * webhooks-trigger-events.test.ts / automation-engine.test.ts. `audit()` é
 * mockado só pra ESCREVER em api_audit_log via `sql()` em vez do client HTTP
 * real (que falha rápido contra a URL fake do vitest.db.config.ts) — sem isso
 * não dá pra provar a linha `automation.rule_executed` (Fix 2).
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...actual,
    audit: vi.fn((entry: Record<string, unknown>) => {
      sql(`
        insert into public.api_audit_log (action, organization_id, resource_type, resource_id, metadata)
          values (
            ${sqlString(String(entry.action))},
            ${entry.organizationId ? sqlString(String(entry.organizationId)) : "null"},
            ${entry.resourceType ? sqlString(String(entry.resourceType)) : "null"},
            ${entry.resourceId ? sqlString(String(entry.resourceId)) : "null"},
            ${sqlString(JSON.stringify(entry.metadata ?? {}))}::jsonb
          );
      `);
      return Promise.resolve();
    }),
  };
});

function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return `ARRAY[${v.map((x) => sqlString(String(x))).join(",")}]::text[]`;
  if (typeof v === "object") return `${sqlString(JSON.stringify(v))}::jsonb`;
  return sqlString(String(v));
}

type QResult = { data: unknown; error: { message: string } | null };

/** Double genérico de PostgrestQueryBuilder (select/insert/update/eq/in/order/maybeSingle/then). */
class FakeQB implements PromiseLike<QResult> {
  private mode: "select" | "insert" | "update" = "select";
  private cols = "*";
  private selectAfterMutation = false;
  private mutationData: Record<string, unknown> | null = null;
  private filters: string[] = [];
  private orderCol?: string;
  private orderAsc = true;

  constructor(private table: string) {}

  select(cols: string): this {
    if (this.mode !== "select") this.selectAfterMutation = true;
    this.cols = cols;
    return this;
  }
  insert(data: Record<string, unknown>): this {
    this.mode = "insert";
    this.mutationData = data;
    return this;
  }
  update(data: Record<string, unknown>): this {
    this.mode = "update";
    this.mutationData = data;
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push(`${col} = ${sqlLiteral(val)}`);
    return this;
  }
  in(col: string, vals: unknown[]): this {
    this.filters.push(`${col} = ANY(ARRAY[${vals.map((v) => sqlLiteral(v)).join(",")}]::uuid[])`);
    return this;
  }
  order(col: string, opts: { ascending: boolean }): this {
    this.orderCol = col;
    this.orderAsc = opts.ascending;
    return this;
  }

  async maybeSingle(): Promise<QResult> {
    const { data, error } = await this.execute();
    if (error) return { data: null, error };
    const rows = (data as unknown[] | null) ?? [];
    return { data: rows[0] ?? null, error: null };
  }

  private where(): string {
    return this.filters.length ? ` where ${this.filters.join(" and ")}` : "";
  }

  private toSql(): string {
    if (this.mode === "select") {
      let q = `select ${this.cols} from public.${this.table}${this.where()}`;
      if (this.orderCol) q += ` order by ${this.orderCol} ${this.orderAsc ? "asc" : "desc"}`;
      return q;
    }
    if (this.mode === "insert") {
      const cols = Object.keys(this.mutationData!);
      const vals = cols.map((c) => sqlLiteral(this.mutationData![c]));
      return `insert into public.${this.table} (${cols.join(", ")}) values (${vals.join(", ")})`;
    }
    const setClauses = Object.entries(this.mutationData!)
      .map(([k, v]) => `${k} = ${sqlLiteral(v)}`)
      .join(", ");
    return `update public.${this.table} set ${setClauses}${this.where()}`;
  }

  private async execute(): Promise<QResult> {
    try {
      const needsRows = this.mode === "select" || this.selectAfterMutation;
      if (needsRows) {
        const inner = this.toSql();
        const wrapped =
          this.mode === "select"
            ? `select coalesce(json_agg(t), '[]') from (${inner}) t;`
            : `with w as (${inner} returning ${this.cols}) select coalesce(json_agg(w), '[]') from w;`;
        const out = sql(wrapped);
        return { data: JSON.parse(out || "[]"), error: null };
      }
      sql(`${this.toSql()};`);
      return { data: null, error: null };
    } catch (err) {
      return { data: null, error: { message: (err as Error).message } };
    }
  }

  then<TResult1 = QResult, TResult2 = never>(
    onfulfilled?: ((value: QResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

interface EmitEventParams {
  p_event_type: string;
  p_entity_kind: string;
  p_entity_id: string | null;
  p_payload: unknown;
  p_metadata: unknown;
  p_organization_id: string;
}

function fakeClient(): SupabaseClient {
  return {
    from: (table: string) => new FakeQB(table),
    rpc: (name: string, params: Record<string, unknown>): Promise<QResult> => {
      return (async () => {
        if (name !== "emit_event") throw new Error(`fakeClient: unsupported rpc ${name}`);
        const p = params as unknown as EmitEventParams;
        try {
          sql(
            `select public.emit_event(${sqlString(p.p_event_type)}, ${sqlString(p.p_entity_kind)}, ${
              p.p_entity_id ? sqlString(p.p_entity_id) : "null"
            }, ${sqlString(JSON.stringify(p.p_payload))}::jsonb, ${sqlString(
              JSON.stringify(p.p_metadata),
            )}::jsonb, ${sqlString(p.p_organization_id)});`,
          );
          return { data: null, error: null };
        } catch (err) {
          return { data: null, error: { message: (err as Error).message } };
        }
      })();
    },
  } as unknown as SupabaseClient;
}

function eventRows(
  eventType: string,
  entityKind: string,
  entityIds: string[],
): Array<{ entity_id: string; payload: Record<string, unknown> }> {
  const idList = entityIds.map((id) => sqlString(id)).join(",");
  const out = sql(`
    select coalesce(json_agg(t), '[]') from (
      select entity_id, payload from public.event_log
      where event_type = ${sqlString(eventType)}
        and entity_kind = ${sqlString(entityKind)}
        and entity_id in (${idList})
      order by created_at
    ) t;
  `);
  return JSON.parse(out || "[]");
}

function aggregateEventCount(eventType: string, organizationId: string): number {
  return Number(
    lastLine(
      sql(
        `select count(*) from public.event_log where event_type = ${sqlString(
          eventType,
        )} and entity_id is null and organization_id = ${sqlString(organizationId)};`,
      ),
    ),
  );
}

function auditRows(action: string, organizationId: string): Array<{ metadata: Record<string, unknown> }> {
  const out = sql(`
    select coalesce(json_agg(t), '[]') from (
      select metadata from public.api_audit_log
      where action = ${sqlString(action)} and organization_id = ${sqlString(organizationId)}
    ) t;
  `);
  return JSON.parse(out || "[]");
}

function baseEventRow(
  overrides: Partial<EventRow> & Pick<EventRow, "id" | "event_type" | "entity_kind" | "organization_id">,
): EventRow {
  return {
    entity_id: null,
    payload: {},
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...overrides,
  };
}

function emitRealEvent(eventType: string, entityKind: string, entityId: string, org: string): string {
  const out = sql(
    `select public.emit_event(${sqlString(eventType)}, ${sqlString(entityKind)}, ${sqlString(entityId)}, '{}'::jsonb, '{}'::jsonb, ${sqlString(org)});`,
  );
  return lastLine(out);
}

// Namespace próprio ('ffffffff-') — org DEDICADA (não reusa GOV_ORG: as
// automation_rules R1-R6 de automation-engine.test.ts escutam GOV_ORG/ORG_2).
const ORG = "ffffffff-b000-4000-8000-000000000001";
const PIPELINE = "ffffffff-b500-4000-8000-000000000001";
const STAGE_A = "ffffffff-b550-4000-8000-000000000001";
const STAGE_B = "ffffffff-b550-4000-8000-000000000002";
const LEAD_M1 = "ffffffff-b600-4000-8000-000000000001";
const LEAD_M2 = "ffffffff-b600-4000-8000-000000000002";
const LEAD_T1 = "ffffffff-b600-4000-8000-000000000003";
const LEAD_T2 = "ffffffff-b600-4000-8000-000000000004";
const RULE_UNKNOWN = "ffffffff-b700-4000-8000-000000000001";
const FAKE_USER_ID = "ffffffff-b100-4000-8000-000000000001";

const FAKE_USER: AuthUser = {
  id: FAKE_USER_ID,
  email: "bulkev@invariant.test",
  full_name: null,
  avatar_url: null,
  is_platform_admin: false,
  organizations: [{ organization_id: ORG, organization_name: "Gov Inv BulkEv", role: "manager" }],
};

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'gov-inv-bulkev', 'Gov Invariant BulkEv', 'Gov Inv BulkEv')
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPELINE}', '${ORG}', 'Gov Inv BulkEv', 'gov-inv-bulkev')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values
        ('${STAGE_A}', '${ORG}', '${PIPELINE}', 'Stage A', 'bulkev-a', 1000),
        ('${STAGE_B}', '${ORG}', '${PIPELINE}', 'Stage B', 'bulkev-b', 2000)
      on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, tags)
      values
        ('${LEAD_M1}', '${ORG}', '${PIPELINE}', '${STAGE_A}', 'BulkEv move lead 1', '{}'::text[]),
        ('${LEAD_M2}', '${ORG}', '${PIPELINE}', '${STAGE_A}', 'BulkEv move lead 2', '{}'::text[]),
        ('${LEAD_T1}', '${ORG}', '${PIPELINE}', '${STAGE_A}', 'BulkEv tag lead 1', '{}'::text[]),
        ('${LEAD_T2}', '${ORG}', '${PIPELINE}', '${STAGE_A}', 'BulkEv tag lead 2', ARRAY['vip']::text[])
      on conflict do nothing;
    insert into public.automation_rules (id, organization_id, name, trigger_event, conditions, actions, is_active)
      values ('${RULE_UNKNOWN}', '${ORG}', 'BulkEv unknown action', 'lead.created', '[]'::jsonb,
        '[{"type":"definitely_unregistered_action"}]'::jsonb, true)
      on conflict do nothing;
  `);

  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: FAKE_USER,
    org: { orgId: ORG, name: "Gov Inv BulkEv", role: "manager" },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createClient).mockResolvedValue(fakeClient() as any);
});

function postReq(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/v1/leads/bulk", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/leads/bulk — eventos por-lead (Fix 1)", () => {
  it("bulk move de 2 leads emite 2 lead.stage_changed com from/to corretos + mantém o agregado", async () => {
    const { POST } = await import("@/app/api/v1/leads/bulk/route");
    const res = await POST(
      postReq({
        action: "move",
        lead_ids: [LEAD_M1, LEAD_M2],
        params: { stage_id: STAGE_B, position_in_stage: 3000 },
      }),
    );
    expect(res.status).toBe(200);

    const rows = eventRows("lead.stage_changed", "crm_lead", [LEAD_M1, LEAD_M2]);
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.payload.pipeline_id).toBe(PIPELINE);
      expect(row.payload.from_stage_id).toBe(STAGE_A);
      expect(row.payload.to_stage_id).toBe(STAGE_B);
    }
    expect(aggregateEventCount("lead.bulk_moved", ORG)).toBe(1);
  });

  it("bulk tag em 2 leads (1 já tinha a tag) emite só 1 lead.tag_added novo (only-when-added)", async () => {
    const { POST } = await import("@/app/api/v1/leads/bulk/route");
    const res = await POST(
      postReq({
        action: "tag",
        lead_ids: [LEAD_T1, LEAD_T2],
        params: { add: ["vip"] },
      }),
    );
    expect(res.status).toBe(200);

    const rows = eventRows("lead.tag_added", "crm_lead", [LEAD_T1, LEAD_T2]);
    expect(rows.length).toBe(1);
    expect(rows[0]!.entity_id).toBe(LEAD_T1);
    expect(rows[0]!.payload.added_tags).toEqual(["vip"]);
    expect(rows[0]!.payload.tags).toEqual(["vip"]);
    expect(aggregateEventCount("lead.bulk_tagged", ORG)).toBe(1);
  });
});

describe("runAutomationForEvent — audit de run falho (Fix 2)", () => {
  it("action type desconhecido → run 'failed' + 1 linha automation.rule_executed auditada", async () => {
    const eventId = emitRealEvent("lead.created", "crm_lead", LEAD_T1, ORG);
    const row = baseEventRow({
      id: eventId,
      event_type: "lead.created",
      entity_kind: "crm_lead",
      entity_id: LEAD_T1,
      organization_id: ORG,
    });

    const result = await runAutomationForEvent(fakeClient(), row);
    expect(result).toEqual({ consumer_key: "automation-rules", status: "ok" });

    const rows = auditRows("automation.rule_executed", ORG);
    expect(rows.length).toBe(1);
    expect(rows[0]!.metadata).toMatchObject({
      rule_id: RULE_UNKNOWN,
      status: "failed",
      event_type: "lead.created",
    });
  });
});
