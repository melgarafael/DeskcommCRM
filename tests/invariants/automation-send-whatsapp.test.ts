import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { getAction } from "@/lib/automation/actions";
import { ensureConversation } from "@/lib/automation/start-conversation";
import type { ActionCtx } from "@/lib/automation/types";
import type { EventRow } from "@/lib/event-log/dispatcher";
import "@/lib/automation/actions/register-all";
import { GOV_ORG, seedGov, sql, lastLine } from "./gov-helpers";

/**
 * Task 11 (spec webhooks/automação 2026-07-17) — ação send_whatsapp_message +
 * ensureConversation + throttle anti-banimento.
 *
 * Mesmo double de admin client dos harnesses irmãos (automation-actions-crud):
 * o Postgres efêmero não tem PostgREST. Aqui o double precisa de MAIS shape
 * que os irmãos porque `sendMessageHandler` faz um select com embed
 * PostgREST-style (`contacts:contact_id(...)`, `channel_sessions:channel_session_id(...)`)
 * — `buildSelectSql()` traduz esses embeds em subqueries `jsonb_build_object`
 * mapeadas por FK->tabela (EMBED_TABLE). `createAdminClient` é mockado (mesmo
 * padrão de automation-actions-crud.test.ts) pra que o `audit()` interno do
 * handler reuse a MESMA instância de double — sem isso ele abriria um client
 * real contra a URL fake do vitest.db.config.ts (falha rápida, engolida, mas
 * suja o console). WAHA não está configurado no ambiente (sem WAHA_API_KEY) —
 * `sendMessageHandler` cai no ramo `queued_reason='waha_not_configured'`, o
 * que prova o caminho inteiro (throttle → ensureConversation → insert →
 * "envio") sem rede.
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

type FilterOp = "eq" | "in";
interface Filter {
  op: FilterOp;
  col: string;
  val: unknown;
}

/** FK -> tabela referenciada, só o suficiente pro embed que sendMessageHandler usa. */
const EMBED_TABLE: Record<string, string> = {
  contact_id: "contacts",
  channel_session_id: "channel_sessions",
};

/**
 * Double mínimo de um PostgrestQueryBuilder: select (com embed PostgREST-style
 * `alias:fk_col(cols)`) / insert / update, eq/in, order/limit, maybeSingle/single.
 */
class FakeQuery implements PromiseLike<QResult> {
  private mode: "select" | "update" | "insert" | null = null;
  private selectCols = "*";
  private selectAfterMutation = false;
  private mutationData: Record<string, unknown> | null = null;
  private filters: Filter[] = [];
  private orderCol?: string;
  private orderAsc = true;
  private limitN?: number;

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

  update(data: Record<string, unknown>): this {
    this.mode = "update";
    this.mutationData = data;
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push({ op: "eq", col, val });
    return this;
  }

  in(col: string, vals: unknown[]): this {
    this.filters.push({ op: "in", col, val: vals });
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

  then<TResult1 = QResult, TResult2 = never>(
    onfulfilled?: ((value: QResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private buildWhere(prefix: string): string {
    if (!this.filters.length) return "";
    const clauses = this.filters.map((f) => {
      if (f.op === "in") {
        const vals = (f.val as unknown[]).map(sqlLiteral).join(", ");
        return `${prefix}${f.col} in (${vals})`;
      }
      return `${prefix}${f.col} = ${sqlLiteral(f.val)}`;
    });
    return ` where ${clauses.join(" and ")}`;
  }

  /** Split top-level da lista de colunas (respeitando parênteses) — distingue coluna
   *  plana de embed PostgREST-style `alias:fk_col(col1, col2, ...)`. */
  private parseCols(): { plain: string[]; embeds: Array<{ alias: string; fk: string; cols: string[] }> } {
    const plain: string[] = [];
    const embeds: Array<{ alias: string; fk: string; cols: string[] }> = [];
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of this.selectCols) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        parts.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) parts.push(cur);
    for (const raw of parts) {
      const p = raw.trim();
      const m = /^(\w+):(\w+)\(([^)]+)\)$/.exec(p);
      if (m) {
        embeds.push({ alias: m[1]!, fk: m[2]!, cols: m[3]!.split(",").map((c) => c.trim()) });
      } else if (p) {
        plain.push(p);
      }
    }
    return { plain, embeds };
  }

  private buildSelectSql(): string {
    const { plain, embeds } = this.parseCols();
    const alias = "b";
    const parts: string[] = [];
    if (!plain.length && !embeds.length) {
      parts.push(`${alias}.*`);
    } else {
      for (const c of plain) parts.push(`${alias}.${c}`);
      for (const e of embeds) {
        const refTable = EMBED_TABLE[e.fk];
        if (!refTable) throw new Error(`FakeQuery: sem mapeamento de embed pra fk ${e.fk}`);
        const objFields = e.cols.map((c) => `${sqlString(c)}, r.${c}`).join(", ");
        parts.push(
          `(select jsonb_build_object(${objFields}) from public.${refTable} r where r.id = ${alias}.${e.fk}) as ${e.alias}`,
        );
      }
    }
    let q = `select ${parts.join(", ")} from public.${this.table} ${alias}${this.buildWhere(`${alias}.`)}`;
    if (this.orderCol) q += ` order by ${alias}.${this.orderCol} ${this.orderAsc ? "asc" : "desc"}`;
    if (this.limitN !== undefined) q += ` limit ${this.limitN}`;
    return q;
  }

  private toSql(): string {
    if (this.mode === "select") return this.buildSelectSql();
    if (this.mode === "update") {
      const setClauses = Object.entries(this.mutationData!)
        .map(([k, v]) => `${k} = ${sqlLiteral(v)}`)
        .join(", ");
      let q = `update public.${this.table} set ${setClauses}${this.buildWhere("")}`;
      if (this.selectAfterMutation) q += ` returning ${this.selectCols}`;
      return q;
    }
    if (this.mode === "insert") {
      const entries = Object.entries(this.mutationData!).filter(([, v]) => v !== undefined);
      const cols = entries.map(([k]) => k).join(", ");
      const vals = entries.map(([, v]) => sqlLiteral(v)).join(", ");
      let q = `insert into public.${this.table} (${cols}) values (${vals})`;
      if (this.selectAfterMutation) q += ` returning ${this.selectCols}`;
      return q;
    }
    throw new Error("fakeAdminClient: no mode set (.select()/.update()/.insert() not called)");
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
      return { data: null, error: { message: stderr } };
    }
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
        if (name !== "emit_event") throw new Error(`fakeAdminClient: unsupported rpc ${name}`);
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

// Namespace próprio (44444444-) — reusa GOV_ORG (seedado por seedGov()).
const SESSION_ID = "44444444-2222-4000-8000-000000000001";
const CONTACT_ID = "44444444-3333-4000-8000-000000000001";
const CONTACT_BLOCKED_ID = "44444444-3333-4000-8000-000000000002";
const RULE_ID = "44444444-1111-4000-8000-000000000001";

beforeAll(() => {
  seedGov();
  sql(`
    do $t11$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status, daily_message_limit)
        values ('${SESSION_ID}', '${GOV_ORG}', 'gov-inv-t11', '\\x00'::bytea, 'WORKING', 300);
    exception when unique_violation then null; end $t11$;
    insert into public.contacts (id, organization_id, display_name, name, phone_number, is_blocked)
      values ('${CONTACT_ID}', '${GOV_ORG}', 'Gov Invariant Contact T11', 'Ana', '+5511999990001', false)
      on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name, name, phone_number, is_blocked)
      values ('${CONTACT_BLOCKED_ID}', '${GOV_ORG}', 'Gov Invariant Contact T11 Blocked', 'Bloqueado', '+5511999990002', true)
      on conflict do nothing;
  `);
});

afterEach(() => {
  vi.useRealTimers();
});

function baseCtx(overrides: Partial<ActionCtx> = {}): ActionCtx {
  return {
    admin,
    organizationId: GOV_ORG,
    ruleId: RULE_ID,
    event: { id: lastLine(sql(`select gen_random_uuid();`)) } as unknown as EventRow,
    context: {},
    requestId: "test-request-id",
    ...overrides,
  };
}

describe("ensureConversation (Task 11)", () => {
  it("1. idempotente: acha a conversa aberta existente em vez de duplicar", async () => {
    const id1 = await ensureConversation(admin, GOV_ORG, CONTACT_ID, SESSION_ID);
    const id2 = await ensureConversation(admin, GOV_ORG, CONTACT_ID, SESSION_ID);
    expect(id2).toBe(id1);

    const found = rows(
      `select id from public.conversations where organization_id = '${GOV_ORG}' and contact_id = '${CONTACT_ID}' and channel_session_id = '${SESSION_ID}'`,
    );
    expect(found.length).toBe(1);
  });
});

describe("send_whatsapp_message — execute (Task 11)", () => {
  it("2. janela aberta (10h): envia, message row com body renderizado do template", async () => {
    vi.setSystemTime(new Date("2026-07-17T10:00:00"));
    const executor = getAction("send_whatsapp_message")!;
    const ctx = baseCtx({
      context: { contact: { id: CONTACT_ID, is_blocked: false, phone_number: "+5511999990001", name: "Ana" } },
    });
    const result = await executor.execute(ctx, {
      channel_session_id: SESSION_ID,
      template: "Oi {{contact.name}}",
    });

    expect(result.status).toBe("success");
    expect(result.detail?.queued_reason).toBe("waha_not_configured");
    const messageId = String(result.detail?.message_id);
    expect(messageId).toBeTruthy();

    const found = rows(`select body, direction, type, contact_id from public.messages where id = '${messageId}'`);
    expect(found.length).toBe(1);
    expect(found[0]!.body).toBe("Oi Ana");
    expect(found[0]!.direction).toBe("outbound");
    expect(found[0]!.type).toBe("text");
    expect(found[0]!.contact_id).toBe(CONTACT_ID);
  });
});

describe("send_whatsapp_message — postponeUntil (Task 11)", () => {
  it("3. fora da janela (23h): adia pra 7h de amanhã", async () => {
    vi.setSystemTime(new Date("2026-07-17T23:00:00"));
    const executor = getAction("send_whatsapp_message")!;
    const until = await executor.postponeUntil!(baseCtx(), {
      channel_session_id: SESSION_ID,
      template: "x",
    });
    expect(until).not.toBeNull();
    const next = new Date(until!);
    expect(next.getHours()).toBe(7);
    expect(next.getDate()).toBe(18);
  });

  it("4. limite diário atingido: adia pra 7h de amanhã (daily_limit)", async () => {
    vi.setSystemTime(new Date("2026-07-17T10:00:00"));
    sql(`
      insert into public.channel_session_warmup (channel_session_id, organization_id, day, messages_sent)
        values ('${SESSION_ID}', '${GOV_ORG}', '2026-07-17', 300)
        on conflict do nothing;
    `);
    const executor = getAction("send_whatsapp_message")!;
    const until = await executor.postponeUntil!(baseCtx(), {
      channel_session_id: SESSION_ID,
      template: "x",
    });
    expect(until).not.toBeNull();
    const next = new Date(until!);
    expect(next.getHours()).toBe(7);
    expect(next.getDate()).toBe(18);
  });
});

describe("send_whatsapp_message — contato bloqueado (Task 11)", () => {
  it("5. contato bloqueado: skipped, zero mensagens inseridas", async () => {
    vi.setSystemTime(new Date("2026-07-17T10:00:00"));
    const before = rows(`select id from public.messages where contact_id = '${CONTACT_BLOCKED_ID}'`).length;
    const executor = getAction("send_whatsapp_message")!;
    const ctx = baseCtx({
      context: { contact: { id: CONTACT_BLOCKED_ID, is_blocked: true, phone_number: "+5511999990002", name: "Bloqueado" } },
    });
    const result = await executor.execute(ctx, {
      channel_session_id: SESSION_ID,
      template: "Oi {{contact.name}}",
    });

    expect(result.status).toBe("skipped");
    expect(result.detail?.reason).toBe("contact_blocked");
    const after = rows(`select id from public.messages where contact_id = '${CONTACT_BLOCKED_ID}'`).length;
    expect(after).toBe(before);
  });
});
