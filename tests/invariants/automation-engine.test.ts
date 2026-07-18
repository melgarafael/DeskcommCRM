import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { AUTOMATION_CONSUMER_KEY, runAutomationForEvent } from "@/lib/automation/engine";
import { registerAction } from "@/lib/automation/actions";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { GOV_LEAD, GOV_ORG, seedGov, sql, lastLine } from "./gov-helpers";

/**
 * Task 8 (spec webhooks/automação 2026-07-17) — engine do motor de regras.
 *
 * Mesmo double de admin client dos harnesses irmãos (webhooks-trigger-events,
 * event-log-drain): o Postgres efêmero deste harness não tem PostgREST, então
 * `fakeAdminClient()` traduz o shape que `engine.ts` usa
 * (.from().select()/.insert()/.update() + .eq()/.order()/.maybeSingle())
 * pra SQL via `sql()` (docker exec psql).
 *
 * `automation_rules` (R1-R6) são seedadas via SQL cru (jsonb literal) — mais
 * simples que passar pelo fake client pra popular conditions/actions.
 * Eventos que resultam em INSERT em automation_rule_runs (FK event_id) usam
 * `emit_event` real via RPC; casos que retornam antes de qualquer insert
 * (anti-loop, postpone) usam um EventRow montado na mão (nenhum FK tocado).
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

type QResult = { data: unknown; error: { message: string } | null };

class FakeQuery implements PromiseLike<QResult> {
  private mode: "select" | "insert" | "update" = "select";
  private selectCols = "*";
  private selectAfterMutation = false;
  private mutationData: Record<string, unknown> | null = null;
  private filters: Array<{ col: string; val: unknown }> = [];
  private orderCol?: string;
  private orderAsc = true;

  constructor(private table: string) {}

  select(cols: string): this {
    if (this.mode !== "select") {
      this.selectAfterMutation = true;
      this.selectCols = cols;
      return this;
    }
    this.selectCols = cols;
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
    this.filters.push({ col, val });
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
    return this.filters.length
      ? ` where ${this.filters.map((f) => `${f.col} = ${sqlLiteral(f.val)}`).join(" and ")}`
      : "";
  }

  private toSql(): string {
    if (this.mode === "select") {
      let q = `select ${this.selectCols} from public.${this.table}${this.where()}`;
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
            : `with w as (${inner} returning ${this.selectCols}) select coalesce(json_agg(w), '[]') from w;`;
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

function fakeAdminClient(): SupabaseClient {
  return { from: (table: string) => new FakeQuery(table) } as unknown as SupabaseClient;
}

function emitRealEvent(eventType: string, entityKind: string, entityId: string, org = GOV_ORG): string {
  const out = sql(
    `select public.emit_event(${sqlString(eventType)}, ${sqlString(entityKind)}, ${sqlString(entityId)}, '{}'::jsonb, '{}'::jsonb, ${sqlString(org)});`,
  );
  return lastLine(out);
}

function baseRow(overrides: Partial<EventRow> & Pick<EventRow, "id" | "event_type" | "entity_kind">): EventRow {
  return {
    organization_id: GOV_ORG,
    entity_id: null,
    payload: {},
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...overrides,
  };
}

function runsCount(): number {
  return Number(lastLine(sql(`select count(*) from public.automation_rule_runs;`)));
}

function runsForRule(ruleId: string): Array<{ status: string; actions_result: Array<{ type: string; status: string; error?: string }> }> {
  const out = sql(
    `select coalesce(json_agg(t), '[]') from (select status, actions_result from public.automation_rule_runs where rule_id = ${sqlString(ruleId)} order by created_at) t;`,
  );
  return JSON.parse(out || "[]");
}

function ruleState(ruleId: string): { run_count: number; last_run_at: string | null } {
  const out = sql(
    `select coalesce(json_agg(t), '[]') from (select run_count, last_run_at from public.automation_rules where id = ${sqlString(ruleId)}) t;`,
  );
  const rows = JSON.parse(out || "[]");
  if (!rows.length) throw new Error(`automation_rules row ${ruleId} not found`);
  return rows[0];
}

// Namespace próprio (dddddddd-) pra org2 e regras — reusa GOV_ORG/GOV_LEAD (já
// seedados por seedGov()) como entidade-alvo.
const ORG_2 = "dddddddd-0000-4000-8000-000000000001";
const R1 = "dddddddd-1111-4000-8000-000000000001";
const R2 = "dddddddd-1111-4000-8000-000000000002";
const R3 = "dddddddd-1111-4000-8000-000000000003";
const R4 = "dddddddd-1111-4000-8000-000000000004";
const R5 = "dddddddd-1111-4000-8000-000000000005";
const R6 = "dddddddd-1111-4000-8000-000000000006";

let fakeOkCalls = 0;
registerAction({
  type: "fake_ok",
  async execute() {
    fakeOkCalls += 1;
    return { type: "fake_ok", status: "success" };
  },
});
registerAction({
  type: "fake_fail",
  async execute() {
    return { type: "fake_fail", status: "failed", error: "boom" };
  },
});
registerAction({
  type: "fake_postpone",
  async postponeUntil() {
    return new Date(Date.now() + 3600_000).toISOString();
  },
  async execute() {
    return { type: "fake_postpone", status: "success" };
  },
});

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_2}', 'gov-inv-t8', 'Gov Invariant Org 2 (Task 8)', 'Gov Inv T8')
      on conflict do nothing;
    insert into public.automation_rules (id, organization_id, name, trigger_event, conditions, actions, is_active)
      values
        ('${R1}', '${GOV_ORG}', 'R1', 'lead.created', '[]'::jsonb,
          '[{"type":"fake_ok"},{"type":"fake_fail"},{"type":"fake_ok"}]'::jsonb, true),
        ('${R2}', '${GOV_ORG}', 'R2', 'lead.created',
          '[{"field":"lead.title","op":"eq","value":"NUNCA"}]'::jsonb,
          '[{"type":"fake_ok"}]'::jsonb, true),
        ('${R3}', '${GOV_ORG}', 'R3', 'lead.created', '[]'::jsonb,
          '[{"type":"fake_ok"}]'::jsonb, false),
        ('${R4}', '${ORG_2}', 'R4', 'lead.created', '[]'::jsonb,
          '[{"type":"fake_ok"}]'::jsonb, true),
        ('${R5}', '${GOV_ORG}', 'R5', 'lead.stage_changed', '[]'::jsonb,
          '[{"type":"fake_postpone"},{"type":"fake_ok"}]'::jsonb, true),
        ('${R6}', '${GOV_ORG}', 'R6', 'lead.tag_added', '[]'::jsonb,
          '[{"type":"nope"}]'::jsonb, true)
      on conflict do nothing;
  `);
});

describe("runAutomationForEvent — motor de regras (Task 8)", () => {
  it("executa as ações de R1 em ordem (erro no meio não aborta), pula R2/R3/R4", async () => {
    const eventId = emitRealEvent("lead.created", "crm_lead", GOV_LEAD);
    const row = baseRow({ id: eventId, event_type: "lead.created", entity_kind: "crm_lead", entity_id: GOV_LEAD });

    const result = await runAutomationForEvent(fakeAdminClient(), row);
    expect(result).toEqual({ consumer_key: AUTOMATION_CONSUMER_KEY, status: "ok" });

    const r1Runs = runsForRule(R1);
    expect(r1Runs.length).toBe(1);
    expect(r1Runs[0]!.status).toBe("partial");
    expect(r1Runs[0]!.actions_result.map((a) => a.status)).toEqual(["success", "failed", "success"]);

    expect(runsForRule(R2).length).toBe(0);
    expect(runsForRule(R3).length).toBe(0);
    expect(runsForRule(R4).length).toBe(0);

    const r1State = ruleState(R1);
    expect(r1State.run_count).toBe(1);
    expect(r1State.last_run_at).not.toBeNull();
  });

  it("anti-loop: metadata.caused_by_rule pula o evento sem gravar runs", async () => {
    const before = runsCount();
    const row = baseRow({
      id: "00000000-0000-4000-8000-000000000001",
      event_type: "lead.created",
      entity_kind: "crm_lead",
      entity_id: GOV_LEAD,
      metadata: { caused_by_rule: R1 },
    });

    const result = await runAutomationForEvent(fakeAdminClient(), row);
    expect(result).toEqual({ consumer_key: AUTOMATION_CONSUMER_KEY, status: "skipped", detail: "caused_by_rule" });
    expect(runsCount()).toBe(before);
  });

  it("anti-loop: metadata.request_id prefixado 'rule:' também pula (mecanismo da Task 9)", async () => {
    const before = runsCount();
    const row = baseRow({
      id: "00000000-0000-4000-8000-000000000002",
      event_type: "lead.created",
      entity_kind: "crm_lead",
      entity_id: GOV_LEAD,
      metadata: { request_id: `rule:${R1}` },
    });

    const result = await runAutomationForEvent(fakeAdminClient(), row);
    expect(result).toEqual({ consumer_key: AUTOMATION_CONSUMER_KEY, status: "skipped", detail: "caused_by_rule" });
    expect(runsCount()).toBe(before);
  });

  it("postpone: adia o evento inteiro ANTES de qualquer ação (all-or-nothing), zero runs", async () => {
    const before = runsCount();
    const okBefore = fakeOkCalls;
    const row = baseRow({
      id: "00000000-0000-4000-8000-000000000003",
      event_type: "lead.stage_changed",
      entity_kind: "crm_lead",
      entity_id: GOV_LEAD,
    });

    const result = await runAutomationForEvent(fakeAdminClient(), row);
    expect(result.consumer_key).toBe(AUTOMATION_CONSUMER_KEY);
    expect(result.status).toBe("retry");
    expect(result.retry_at).toBeDefined();
    const deltaMs = new Date(result.retry_at!).getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(55 * 60_000);
    expect(deltaMs).toBeLessThan(65 * 60_000);

    expect(runsCount()).toBe(before);
    expect(fakeOkCalls).toBe(okBefore); // fake_ok (2ª ação de R5) NÃO executou
  });

  it("ação de type desconhecido: run registrado com status='failed', demais ações seguiriam", async () => {
    const eventId = emitRealEvent("lead.tag_added", "crm_lead", GOV_LEAD);
    const row = baseRow({ id: eventId, event_type: "lead.tag_added", entity_kind: "crm_lead", entity_id: GOV_LEAD });

    const result = await runAutomationForEvent(fakeAdminClient(), row);
    expect(result).toEqual({ consumer_key: AUTOMATION_CONSUMER_KEY, status: "ok" });

    const runs = runsForRule(R6);
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.actions_result).toEqual([{ type: "nope", status: "failed", error: "unknown_action" }]);
  });

  it("entity_kind mismatch (trigger legado fn_emit_event_on_lead_change, entity_kind='lead'): skip, zero runs", async () => {
    const before = runsCount();
    const eventId = emitRealEvent("lead.created", "lead", GOV_LEAD);
    const row = baseRow({ id: eventId, event_type: "lead.created", entity_kind: "lead", entity_id: GOV_LEAD });

    const result = await runAutomationForEvent(fakeAdminClient(), row);
    expect(result).toEqual({ consumer_key: AUTOMATION_CONSUMER_KEY, status: "skipped", detail: "entity_kind_mismatch" });
    expect(runsCount()).toBe(before);
  });
});
