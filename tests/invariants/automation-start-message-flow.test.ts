import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { executeStartMessageFlow } from "@/lib/automation/actions/start-message-flow";
import type { ActionCtx } from "@/lib/automation/types";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { flowGraphSchema } from "@/lib/followup/graph-schema";
import { GOV_ORG, seedGov, sql, lastLine } from "./gov-helpers";

/**
 * Ação `start_message_flow` contra Postgres real: o primeiro enroll cria a
 * inscrição viva; o segundo esbarra em `idx_followup_enrollments_one_live`
 * (23505) e a ação falha de forma explícita.
 *
 * Mesmo double de admin client dos harnesses irmãos (sem PostgREST no
 * Postgres efêmero). Unique violation precisa virar `error.code = "23505"`
 * — é o que `enrollFollowupFlow` traduz em `conflict`.
 */

function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") return `${sqlString(JSON.stringify(v))}::jsonb`;
  return sqlString(String(v));
}

type QResult = { data: unknown; error: { message: string; code?: string } | null };
type RowResult = {
  data: Record<string, unknown> | null;
  error: { message: string; code?: string } | null;
};

class FakeQuery implements PromiseLike<QResult> {
  private mode: "select" | "update" | "insert" | null = null;
  private selectCols = "*";
  private selectAfterMutation = false;
  private mutationData: Record<string, unknown> | null = null;
  private filters: Array<{ col: string; val: unknown }> = [];

  constructor(private table: string) {}

  select(cols: string): this {
    if (this.mode === "insert" || this.mode === "update") {
      this.selectAfterMutation = true;
      this.selectCols = cols;
      return this;
    }
    this.mode = "select";
    this.selectCols = cols;
    return this;
  }

  insert(data: Record<string, unknown>): this {
    this.mode = "insert";
    this.mutationData = data;
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push({ col, val });
    return this;
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
    if (rows.length !== 1) {
      return { data: null, error: { message: `expected 1 row, got ${rows.length}` } };
    }
    return { data: rows[0]!, error: null };
  }

  then<TResult1 = QResult, TResult2 = never>(
    onfulfilled?: ((value: QResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private where(): string {
    return this.filters.length
      ? ` where ${this.filters.map((f) => `${f.col} = ${sqlLiteral(f.val)}`).join(" and ")}`
      : "";
  }

  private toSql(): string {
    if (this.mode === "select") {
      return `select ${this.selectCols} from public.${this.table}${this.where()}`;
    }
    if (this.mode === "insert") {
      const entries = Object.entries(this.mutationData!).filter(([, v]) => v !== undefined);
      const cols = entries.map(([k]) => k).join(", ");
      const vals = entries.map(([, v]) => sqlLiteral(v)).join(", ");
      let q = `insert into public.${this.table} (${cols}) values (${vals})`;
      if (this.selectAfterMutation) q += ` returning ${this.selectCols}`;
      return q;
    }
    throw new Error("fakeAdminClient: no mode set");
  }

  private async execute(): Promise<QResult> {
    try {
      const needsRows = this.mode === "select" || this.selectAfterMutation;
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
      const code = /23505|unique_violation|duplicate key/i.test(stderr) ? "23505" : undefined;
      return { data: null, error: { message: stderr, code } };
    }
  }
}

function fakeAdminClient(): SupabaseClient {
  return {
    from: (table: string) => new FakeQuery(table),
    rpc: async (name: string, params: Record<string, unknown>): Promise<QResult> => {
      if (name === "fn_service_boundary" || name === "fn_service_event_origin") {
        try {
          const expression =
            name === "fn_service_boundary"
              ? `public.fn_service_boundary(${sqlLiteral(params.p_org)}::uuid,${sqlLiteral(params.p_conversation)}::uuid)`
              : `public.fn_service_event_origin(${sqlLiteral(params.p_org)}::uuid,${sqlLiteral(params.p_event)}::uuid,${sqlLiteral(params.p_contact)}::uuid,${sqlLiteral(params.p_session)}::uuid)`;
          return { data: JSON.parse(sql(`select ${expression};`)), error: null };
        } catch (error) {
          return { data: null, error: { message: String(error) } };
        }
      }
      if (name !== "fn_service_begin") throw new Error(`unsupported rpc ${name}`);
      try {
        const out = sql(
          `select public.fn_service_begin(p_org => ${sqlLiteral(params.p_org)}::uuid, p_contact => ${sqlLiteral(params.p_contact)}::uuid, p_session => ${sqlLiteral(params.p_session)}::uuid);`,
        );
        return { data: JSON.parse(out), error: null };
      } catch (error) {
        return { data: null, error: { message: String(error) } };
      }
    },
  } as unknown as SupabaseClient;
}

const admin = fakeAdminClient();

const CONTACT_ID = "dddddddd-3333-4000-8000-0000000000c1";
const VERSION_ID = "dddddddd-5555-4000-8000-0000000000c1";
const POINTER_ID = "dddddddd-6666-4000-8000-0000000000c1";
const RULE_ID = "dddddddd-1111-4000-8000-0000000000c1";

const GRAPH = flowGraphSchema.parse({
  nodes: [
    { id: "t1", type: "trigger", label: "t1", position: { x: 0, y: 0 }, config: {} },
    {
      id: "e1",
      type: "end",
      label: "e1",
      position: { x: 0, y: 0 },
      config: { outcome: "exhausted" },
    },
  ],
  edges: [{ id: "edge1", source: "t1", target: "e1", priority: 0, condition: { type: "always" } }],
});

function rows(query: string): Array<Record<string, unknown>> {
  const out = sql(`select coalesce(json_agg(t), '[]') from (${query}) t;`);
  return JSON.parse(out || "[]") as Array<Record<string, unknown>>;
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTACT_ID}', '${GOV_ORG}', 'CRM start_message_flow contact')
      on conflict do nothing;
    insert into public.followup_flow_versions (id, organization_id, graph)
      values ('${VERSION_ID}', '${GOV_ORG}', ${sqlLiteral(GRAPH)})
      on conflict (id) do update set graph = excluded.graph;
    insert into public.followup_flow_pointers
      (id, organization_id, name, status, active_version_id, trigger_config)
      values (
        '${POINTER_ID}',
        '${GOV_ORG}',
        'crm-smf-invariant',
        'active',
        '${VERSION_ID}',
        '{"kind":"webhook"}'::jsonb
      )
      on conflict (id) do update
        set status = 'active',
            active_version_id = excluded.active_version_id;
  `);
});

afterEach(() => {
  sql(`delete from public.followup_enrollments where contact_id = '${CONTACT_ID}';`);
});

function baseCtx(): ActionCtx {
  return {
    admin,
    organizationId: GOV_ORG,
    ruleId: RULE_ID,
    ruleName: "start_message_flow test",
    event: {
      id: lastLine(
        sql(`select public.emit_event('contact.tag_added','contact','${CONTACT_ID}',
      jsonb_build_object('service_origin',jsonb_build_object('kind','command','observed',public.fn_service_observe_command('${GOV_ORG}','${CONTACT_ID}'))),'{}','${GOV_ORG}');`),
      ),
    } as unknown as EventRow,
    context: { contact: { id: CONTACT_ID } },
    requestId: "test-start-message-flow",
  };
}

describe("start_message_flow — enroll no banco", () => {
  it("inscreve o contato no fluxo publicado", async () => {
    const result = await executeStartMessageFlow(baseCtx(), { flow_pointer_id: POINTER_ID });
    expect(result.status).toBe("success");
    expect(result.detail?.enrollment_id).toBeTruthy();

    const found = rows(
      `select id, status, pointer_id from public.followup_enrollments where contact_id = '${CONTACT_ID}'`,
    );
    expect(found.length).toBe(1);
    expect(found[0]!.pointer_id).toBe(POINTER_ID);
    expect(found[0]!.status).toBe("active");
  });

  it("segunda inscrição viva falha de forma explícita", async () => {
    const first = await executeStartMessageFlow(baseCtx(), { flow_pointer_id: POINTER_ID });
    expect(first.status).toBe("success");

    const second = await executeStartMessageFlow(baseCtx(), { flow_pointer_id: POINTER_ID });
    expect(second.status).toBe("failed");
    expect(second.error).toBe("live_enrollment_exists");

    const found = rows(
      `select id from public.followup_enrollments where contact_id = '${CONTACT_ID}'`,
    );
    expect(found.length).toBe(1);
  });
});
