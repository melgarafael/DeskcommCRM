import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { getAction } from "@/lib/automation/actions";
import type { ActionCtx } from "@/lib/automation/types";
import type { EventRow } from "@/lib/event-log/dispatcher";
import "@/lib/automation/actions/register-all";
import { GOV_ORG, GOV_MANAGER, GOV_PIPELINE, GOV_STAGE, seedGov, sql, lastLine } from "./gov-helpers";

/**
 * Task 9 (spec webhooks/automação 2026-07-17) — executores add_tag,
 * assign_owner e create_or_move_lead.
 *
 * Mesmo double de admin client dos harnesses irmãos (webhooks-inbound,
 * automation-engine): o Postgres efêmero deste harness não tem PostgREST.
 * `createLeadHandler`/`moveLeadHandler` (reusados por create-or-move-lead)
 * chamam `audit()`, que abre seu PRÓPRIO client via `createAdminClient()` —
 * por isso o módulo é mockado (mesmo padrão de webhooks-inbound.test.ts) pra
 * devolver a MESMA instância de double usada como `ctx.admin`.
 */

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

type QResult = { data: unknown; error: { message: string; code?: string } | null };
type RowResult = { data: Record<string, unknown> | null; error: { message: string; code?: string } | null };

type FilterOp = "eq" | "is";
interface Filter {
  op: FilterOp;
  col: string;
  val: unknown;
}

/** Double mínimo de PostgrestQueryBuilder — select/insert/update, eq/is, order/limit, maybeSingle/single. */
class FakeQuery implements PromiseLike<QResult> {
  private mode: "select" | "update" | "insert" | null = null;
  private selectCols = "*";
  private selectAfterWrite = false;
  private updateData: Record<string, unknown> | null = null;
  private insertData: Record<string, unknown> | null = null;
  private filters: Filter[] = [];
  private orderCol?: string;
  private orderAsc = true;
  private limitN?: number;

  constructor(private table: string) {}

  select(cols: string): this {
    if (this.mode === "update" || this.mode === "insert") {
      this.selectAfterWrite = true;
      this.selectCols = cols;
      return this;
    }
    this.mode = "select";
    this.selectCols = cols;
    return this;
  }

  update(data: Record<string, unknown>): this {
    this.mode = "update";
    this.updateData = data;
    return this;
  }

  insert(data: Record<string, unknown>): this {
    this.mode = "insert";
    this.insertData = data;
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push({ op: "eq", col, val });
    return this;
  }

  is(col: string, val: unknown): this {
    this.filters.push({ op: "is", col, val });
    return this;
  }

  order(col: string, opts: { ascending: boolean }): this {
    this.orderCol = col;
    this.orderAsc = opts.ascending;
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  private buildWhere(): string {
    if (!this.filters.length) return "";
    const clauses = this.filters.map((f) =>
      f.op === "is" ? `${f.col} is ${f.val === null ? "null" : sqlLiteral(f.val)}` : `${f.col} = ${sqlLiteral(f.val)}`,
    );
    return ` where ${clauses.join(" and ")}`;
  }

  private toSql(): string {
    if (this.mode === "select") {
      let q = `select ${this.selectCols} from public.${this.table}${this.buildWhere()}`;
      if (this.orderCol) q += ` order by ${this.orderCol} ${this.orderAsc ? "asc" : "desc"}`;
      if (this.limitN !== undefined) q += ` limit ${this.limitN}`;
      return q;
    }
    if (this.mode === "update") {
      const setClauses = Object.entries(this.updateData!)
        .map(([k, v]) => `${k} = ${sqlLiteral(v)}`)
        .join(", ");
      let q = `update public.${this.table} set ${setClauses}${this.buildWhere()}`;
      if (this.selectAfterWrite) q += ` returning ${this.selectCols}`;
      return q;
    }
    if (this.mode === "insert") {
      const entries = Object.entries(this.insertData!).filter(([, v]) => v !== undefined);
      const cols = entries.map(([k]) => k).join(", ");
      const vals = entries.map(([, v]) => sqlLiteral(v)).join(", ");
      let q = `insert into public.${this.table} (${cols}) values (${vals})`;
      if (this.selectAfterWrite) q += ` returning ${this.selectCols}`;
      return q;
    }
    throw new Error("fakeAdminClient: no mode set (.select()/.update()/.insert() not called)");
  }

  private async execute(): Promise<QResult> {
    try {
      const needsRows = this.mode === "select" || this.selectAfterWrite;
      if (needsRows) {
        const inner = this.toSql();
        const wrapped =
          this.mode === "select"
            ? `select coalesce(json_agg(t), '[]') from (${inner}) t;`
            : `with w as (${inner}) select coalesce(json_agg(w), '[]') from w;`;
        const out = sql(wrapped);
        return { data: JSON.parse(out || "[]"), error: null };
      }
      sql(`${this.toSql()};`);
      return { data: null, error: null };
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? (err as Error).message;
      const code = stderr.includes("duplicate key value violates unique constraint") ? "23505" : undefined;
      return { data: null, error: { message: stderr, code } };
    }
  }

  then<TResult1 = QResult, TResult2 = never>(
    onfulfilled?: ((value: QResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  async maybeSingle(): Promise<RowResult> {
    const { data, error } = await this.execute();
    if (error) return { data: null, error };
    const rows = (data as Array<Record<string, unknown>>) ?? [];
    return { data: rows[0] ?? null, error: null };
  }

  async single(): Promise<RowResult> {
    const { data, error } = await this.execute();
    if (error) return { data: null, error };
    const rows = (data as Array<Record<string, unknown>>) ?? [];
    if (rows.length !== 1) return { data: null, error: { message: `expected 1 row, got ${rows.length}` } };
    return { data: rows[0]!, error: null };
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

function fakeAdminClient(): SupabaseClient {
  return {
    from: (table: string) => new FakeQuery(table),
    rpc: (name: string, params: Record<string, unknown>): Promise<QResult> => {
      return (async () => {
        if (name !== "emit_event") {
          throw new Error(`fakeAdminClient: unsupported rpc ${name}`);
        }
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

const admin = fakeAdminClient();
vi.mocked(createAdminClient).mockReturnValue(admin);

function rows(query: string): Array<Record<string, unknown>> {
  const out = sql(`select coalesce(json_agg(t), '[]') from (${query}) t;`);
  return JSON.parse(out || "[]");
}
function row(query: string): Record<string, unknown> {
  const found = rows(query);
  if (!found.length) throw new Error(`row(): 0 rows for ${query}`);
  return found[0]!;
}

// Namespace próprio (22222222-) — reusa GOV_ORG/GOV_MANAGER/GOV_PIPELINE/GOV_STAGE
// (já seedados por seedGov()); segunda org só pra provar isolamento de membership.
const RULE_ID = "22222222-1111-4000-8000-000000000001";
const OTHER_ORG = "22222222-0000-4000-8000-000000000001";
const OTHER_ORG_USER = "22222222-1111-4000-8000-000000000002";
const STAGE_2 = "22222222-5555-4000-8000-000000000001";
const PIPE_2 = "22222222-5555-4000-8000-000000000002";
const STAGE_PIPE_2 = "22222222-5555-4000-8000-000000000003";
const LEAD_T9 = "22222222-6666-4000-8000-000000000001";
const CONTACT_T9 = "22222222-3333-4000-8000-000000000001";

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${OTHER_ORG}', 'gov-inv-t9', 'Gov Invariant Org (Task 9)', 'Gov Inv T9')
      on conflict do nothing;
    insert into auth.users (id, email) values ('${OTHER_ORG_USER}', 'gov-t9-other@invariant.test') on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${OTHER_ORG_USER}', '${OTHER_ORG}', 'agent', now())
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${STAGE_2}', '${GOV_ORG}', '${GOV_PIPELINE}', 'Stage 2', 'stage-2', 2000)
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPE_2}', '${GOV_ORG}', 'Pipeline 2 (Task 9)', 'gov-inv-t9-pipe2')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${STAGE_PIPE_2}', '${GOV_ORG}', '${PIPE_2}', 'Stage', 'stage', 1000)
      on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTACT_T9}', '${GOV_ORG}', 'Gov Invariant Contact T9')
      on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, tags)
      values ('${LEAD_T9}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Gov invariant lead T9', '{}')
      on conflict do nothing;
  `);
});

function baseCtx(context: Record<string, unknown>, overrides: Partial<ActionCtx> = {}): ActionCtx {
  return {
    admin,
    organizationId: GOV_ORG,
    ruleId: RULE_ID,
    event: { id: lastLine(sql(`select gen_random_uuid();`)) } as unknown as EventRow,
    context,
    requestId: "test-request-id",
    ...overrides,
  };
}

function leadRow(id: string): Record<string, unknown> {
  return row(`select * from public.crm_leads where id = '${id}'`);
}
function contactRow(id: string): Record<string, unknown> {
  return row(`select * from public.contacts where id = '${id}'`);
}

describe("add_tag (Task 9)", () => {
  it("1. merge idempotente nas tags do lead do contexto", async () => {
    const executor = getAction("add_tag")!;
    const ctx = baseCtx({ lead: leadRow(LEAD_T9) });
    const result = await executor.execute(ctx, { tags: ["vip"] });
    expect(result.status).toBe("success");
    expect(leadRow(LEAD_T9).tags).toEqual(["vip"]);
  });

  it("2. execute de novo com tag repetida + nova — merge sem duplicar", async () => {
    const executor = getAction("add_tag")!;
    const ctx = baseCtx({ lead: leadRow(LEAD_T9) });
    const result = await executor.execute(ctx, { tags: ["vip", "novo"] });
    expect(result.status).toBe("success");
    expect(leadRow(LEAD_T9).tags).toEqual(["vip", "novo"]);
  });

  it("3. evento lead.tag_added emitido carrega metadata.caused_by_rule = ruleId", async () => {
    const found = rows(
      `select metadata from public.event_log where event_type = 'lead.tag_added' and entity_id = '${LEAD_T9}' order by created_at desc limit 1`,
    );
    expect(found.length).toBe(1);
    expect((found[0]!.metadata as Record<string, unknown>).caused_by_rule).toBe(RULE_ID);
  });
});

describe("assign_owner (Task 9)", () => {
  it("4. valida membership na org e seta owner_user_id + assigned_at", async () => {
    const executor = getAction("assign_owner")!;
    const ctx = baseCtx({ lead: leadRow(LEAD_T9) });
    const result = await executor.execute(ctx, { user_id: GOV_MANAGER });
    expect(result.status).toBe("success");
    const lead = leadRow(LEAD_T9);
    expect(lead.owner_user_id).toBe(GOV_MANAGER);
    expect(lead.assigned_at).not.toBeNull();
  });

  it("5. usuário de outra org — failed user_not_in_org, owner_user_id inalterado", async () => {
    const executor = getAction("assign_owner")!;
    const before = leadRow(LEAD_T9).owner_user_id;
    const ctx = baseCtx({ lead: leadRow(LEAD_T9) });
    const result = await executor.execute(ctx, { user_id: OTHER_ORG_USER });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("user_not_in_org");
    expect(leadRow(LEAD_T9).owner_user_id).toBe(before);
  });
});

describe("create_or_move_lead (Task 9)", () => {
  it("6. contexto com lead + stage2 do mesmo pipeline — move, evento request_id prefixado rule:", async () => {
    const executor = getAction("create_or_move_lead")!;
    const ctx = baseCtx({ lead: leadRow(LEAD_T9) });
    const result = await executor.execute(ctx, { pipeline_id: GOV_PIPELINE, stage_id: STAGE_2 });
    expect(result.status).toBe("success");
    expect(leadRow(LEAD_T9).stage_id).toBe(STAGE_2);

    const found = rows(
      `select metadata from public.event_log where event_type = 'lead.stage_changed' and entity_id = '${LEAD_T9}' order by created_at desc limit 1`,
    );
    expect(found.length).toBe(1);
    const metadata = found[0]!.metadata as Record<string, unknown>;
    expect(String(metadata.request_id ?? "")).toBe(`rule:${RULE_ID}`);
  });

  it("7. contexto só com contact — cria lead novo, lead.created carrega request_id rule:", async () => {
    const executor = getAction("create_or_move_lead")!;
    const ctx = baseCtx({ contact: contactRow(CONTACT_T9) });
    const result = await executor.execute(ctx, { pipeline_id: GOV_PIPELINE, stage_id: GOV_STAGE });
    expect(result.status).toBe("success");
    const createdId = String(result.detail?.created);
    expect(createdId).toBeTruthy();

    const created = leadRow(createdId);
    expect(created.contact_id).toBe(CONTACT_T9);
    expect(created.pipeline_id).toBe(GOV_PIPELINE);
    expect(created.stage_id).toBe(GOV_STAGE);

    const found = rows(
      `select metadata from public.event_log where event_type = 'lead.created' and entity_id = '${createdId}' order by created_at desc limit 1`,
    );
    expect(found.length).toBe(1);
    const metadata = found[0]!.metadata as Record<string, unknown>;
    expect(String(metadata.request_id ?? "")).toBe(`rule:${RULE_ID}`);
  });

  it("8 (bonus). pipeline diferente do lead do contexto — failed cross_pipeline_move_not_allowed, stage inalterado", async () => {
    const executor = getAction("create_or_move_lead")!;
    const before = leadRow(LEAD_T9).stage_id;
    const ctx = baseCtx({ lead: leadRow(LEAD_T9) });
    const result = await executor.execute(ctx, { pipeline_id: PIPE_2, stage_id: STAGE_PIPE_2 });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("cross_pipeline_move_not_allowed");
    expect(leadRow(LEAD_T9).stage_id).toBe(before);
  });
});
