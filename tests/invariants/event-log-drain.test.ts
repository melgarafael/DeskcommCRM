import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { registerHandler, type EventRow, type HandlerResult } from "@/lib/event-log/dispatcher";
import { drainEventLog } from "@/lib/event-log/drain";
import { GOV_ORG, seedGov, sql, lastLine } from "./gov-helpers";

/**
 * Drain genérico do event_log (Task 2, spec webhooks/automação 2026-07-17).
 *
 * Este harness (scripts/test-db.sh) sobe SÓ um Postgres cru — sem PostgREST,
 * sem HTTP — então não existe um `SupabaseClient` real pra passar a
 * `drainEventLog(admin, ...)` (mesma limitação documentada em
 * webhooks-rls.test.ts). `fakeAdminClient()` abaixo é um double mínimo do
 * shape que `drain.ts` efetivamente usa (`.from().select()/.update()` +
 * filtros `.eq/.lte/.in/.or/.order/.limit`), traduzido pra SQL via o mesmo
 * `sql()` (docker exec psql) que o resto da suíte usa — não testa nada além
 * da lógica do drain em si.
 */

function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return `ARRAY[${v.map((x) => sqlString(String(x))).join(",")}]::text[]`;
  return sqlString(String(v));
}

type FilterOp = "eq" | "lte" | "in" | "or";
interface Filter {
  op: FilterOp;
  col?: string;
  val?: unknown;
  raw?: string;
}

class FakeQuery implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private mode: "select" | "update" | null = null;
  private selectCols = "*";
  private selectAfterUpdate = false;
  private updateData: Record<string, unknown> | null = null;
  private filters: Filter[] = [];
  private orderCol?: string;
  private orderAsc = true;
  private limitN?: number;

  constructor(private table: string) {}

  select(cols: string): this {
    if (this.mode === "update") {
      this.selectAfterUpdate = true;
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

  eq(col: string, val: unknown): this {
    this.filters.push({ op: "eq", col, val });
    return this;
  }

  lte(col: string, val: unknown): this {
    this.filters.push({ op: "lte", col, val });
    return this;
  }

  in(col: string, val: unknown[]): this {
    this.filters.push({ op: "in", col, val });
    return this;
  }

  or(raw: string): this {
    this.filters.push({ op: "or", raw });
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
    const clauses = this.filters.map((f) => {
      if (f.op === "eq") return `${f.col} = ${sqlLiteral(f.val)}`;
      if (f.op === "lte") return `${f.col} <= ${sqlLiteral(f.val)}`;
      if (f.op === "in") return `${f.col} in (${(f.val as unknown[]).map(sqlLiteral).join(",")})`;
      if (f.op === "or") {
        // Parses PostgREST-style "col.is.null,col.lte.<iso>" (the only shape drain.ts emits).
        const parts = f.raw!.split(",").map((p) => {
          const [col, kind, arg] = p.split(".") as [string, string, string];
          if (kind === "is" && arg === "null") return `${col} is null`;
          if (kind === "lte") return `${col} <= ${sqlLiteral(arg)}`;
          throw new Error(`fakeAdminClient: unsupported .or() clause: ${p}`);
        });
        return `(${parts.join(" or ")})`;
      }
      throw new Error(`unsupported filter op: ${f.op}`);
    });
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
      if (this.selectAfterUpdate) q += ` returning ${this.selectCols}`;
      return q;
    }
    throw new Error("fakeAdminClient: no mode set (.select()/.update() not called)");
  }

  private async execute(): Promise<{ data: unknown; error: { message: string } | null }> {
    try {
      const needsRows = this.mode === "select" || this.selectAfterUpdate;
      if (needsRows) {
        // json_agg over a multi-column row inserts line breaks between fields
        // (Postgres row_to_json formatting) — parse the whole trimmed output,
        // not just its last line (lastLine() is for single-line scalars).
        // UPDATE ... RETURNING can't be wrapped as `from (update ...) t` (not
        // valid SQL) — needs a CTE instead.
        const inner = this.toSql();
        const wrapped =
          this.mode === "update"
            ? `with w as (${inner}) select coalesce(json_agg(w), '[]') from w;`
            : `select coalesce(json_agg(t), '[]') from (${inner}) t;`;
        const out = sql(wrapped);
        return { data: JSON.parse(out), error: null };
      }
      sql(`${this.toSql()};`);
      return { data: null, error: null };
    } catch (err) {
      return { data: null, error: { message: (err as Error).message } };
    }
  }

  then<TResult1 = { data: unknown; error: { message: string } | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

function fakeAdminClient(): SupabaseClient {
  return { from: (table: string) => new FakeQuery(table) } as unknown as SupabaseClient;
}

function emitDrainCase(mode: string, eventType = "test.drain_case"): string {
  const out = sql(
    `select public.emit_event('${eventType}', 'test', null, '{"mode":"${mode}"}'::jsonb, '{}'::jsonb, '${GOV_ORG}');`,
  );
  return lastLine(out);
}

function rowState(id: string): {
  status: string;
  attempts: number;
  consumed_by: string[];
  last_error: string | null;
  next_attempt_at: string | null;
} {
  const out = sql(
    `select coalesce(json_agg(t), '[]') from (
       select status, attempts, consumed_by, last_error, next_attempt_at
       from public.event_log where id = '${id}'
     ) t;`,
  );
  const rows = JSON.parse(out);
  if (!rows.length) throw new Error(`event_log row ${id} not found`);
  return rows[0];
}

const calls: string[] = [];
registerHandler({
  key: "test-drain-handler",
  events: ["test.drain_case"],
  async handle(row: EventRow): Promise<HandlerResult> {
    calls.push(row.id);
    const mode = String(row.payload.mode ?? "ok");
    if (mode === "error") return { consumer_key: "test-drain-handler", status: "error", detail: "boom" };
    if (mode === "retry")
      return {
        consumer_key: "test-drain-handler",
        status: "retry",
        retry_at: new Date(Date.now() + 3600_000).toISOString(),
      };
    return { consumer_key: "test-drain-handler", status: "ok" };
  },
});

// Segundo handler no mesmo event_type "test.drain_multi": um sempre erra,
// outro sempre pede retry (+1h) — cobre o mix retry+error num mesmo tick.
registerHandler({
  key: "test-drain-multi-err",
  events: ["test.drain_multi"],
  async handle(): Promise<HandlerResult> {
    return { consumer_key: "test-drain-multi-err", status: "error", detail: "multi-boom" };
  },
});
registerHandler({
  key: "test-drain-multi-retry",
  events: ["test.drain_multi"],
  async handle(): Promise<HandlerResult> {
    return {
      consumer_key: "test-drain-multi-retry",
      status: "retry",
      retry_at: new Date(Date.now() + 3600_000).toISOString(),
    };
  },
});

// Handler isolado no event_type "test.drain_retry_no_backoff": pede retry SEM
// retry_at — cobre o fallback de backoff (senão busy-loop a cada tick).
registerHandler({
  key: "test-drain-retry-no-backoff",
  events: ["test.drain_retry_no_backoff"],
  async handle(): Promise<HandlerResult> {
    return { consumer_key: "test-drain-retry-no-backoff", status: "retry" };
  },
});

describe("drainEventLog — cron driver genérico do event_log (migration 0037)", () => {
  let idOk: string;
  let idError: string;
  let idDead: string;
  let idRetry: string;
  let idNoHandler: string;
  let idFuture: string;
  let idMulti: string;
  let idRetryNoBackoff: string;

  beforeAll(() => {
    seedGov();
    idOk = emitDrainCase("ok");
    idError = emitDrainCase("error");
    idDead = emitDrainCase("error");
    idRetry = emitDrainCase("retry");
    idNoHandler = emitDrainCase("ok", "test.no_handler");
    idFuture = emitDrainCase("ok");
    idMulti = emitDrainCase("n/a", "test.drain_multi");
    idRetryNoBackoff = emitDrainCase("n/a", "test.drain_retry_no_backoff");

    // Case 3: pré-seta attempts=4 — próximo erro deve levar a status='dead'.
    sql(`update public.event_log set attempts = 4 where id = '${idDead}';`);
    // Case 6: agenda pro futuro — não deve ser tocado neste tick.
    sql(`update public.event_log set next_attempt_at = now() + interval '1 hour' where id = '${idFuture}';`);
  });

  it("processa o batch e devolve um resumo consistente com os estados finais", async () => {
    const summary = await drainEventLog(fakeAdminClient(), { limit: 50 });

    // scanned = ok + error + dead + retry + multi + retry_no_backoff (6);
    // no_handler e future ficam de fora.
    expect(summary.scanned).toBe(6);
    expect(summary.done).toBe(1);
    expect(summary.retried).toBe(3);
    expect(summary.failed).toBe(1);
    expect(summary.dead).toBe(1);
  });

  it("caso 1 — mode=ok: status='done', consumed_by contém a key", () => {
    const row = rowState(idOk);
    expect(row.status).toBe("done");
    expect(row.consumed_by).toContain("test-drain-handler");
  });

  it("caso 2 — mode=error: status='pending', attempts=1, next_attempt_at no futuro (backoff)", () => {
    const row = rowState(idError);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain("boom");
    expect(row.next_attempt_at).not.toBeNull();
    expect(new Date(row.next_attempt_at!).getTime()).toBeGreaterThan(Date.now());
  });

  it("caso 3 — mode=error com attempts=4 pré-setado: status='dead', last_error='...boom'", () => {
    const row = rowState(idDead);
    expect(row.status).toBe("dead");
    expect(row.attempts).toBe(5);
    expect(row.last_error).toContain("boom");
  });

  it("caso 4 — mode=retry: status='pending', attempts INALTERADO (0), next_attempt_at ≈ +1h", () => {
    const row = rowState(idRetry);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_at).not.toBeNull();
    const deltaMs = new Date(row.next_attempt_at!).getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(55 * 60_000);
    expect(deltaMs).toBeLessThan(65 * 60_000);
  });

  it("caso 5 — evento de tipo SEM handler registrado: não é tocado (segue 'pending')", () => {
    const row = rowState(idNoHandler);
    expect(row.status).toBe("pending");
    expect(row.consumed_by).toEqual([]);
    expect(calls).not.toContain(idNoHandler);
  });

  it("caso 6 — next_attempt_at no futuro: não processado neste tick", () => {
    const row = rowState(idFuture);
    expect(row.status).toBe("pending");
    expect(row.consumed_by).toEqual([]);
    expect(calls).not.toContain(idFuture);
  });

  it("caso 7 — dois handlers no mesmo tick (um error, um retry): retry vence mas preserva last_error do erro, sem contar attempt", () => {
    const row = rowState(idMulti);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.last_error).toContain("test-drain-multi-err");
    expect(row.last_error).toContain("multi-boom");
    expect(row.next_attempt_at).not.toBeNull();
    const deltaMs = new Date(row.next_attempt_at!).getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(55 * 60_000);
    expect(deltaMs).toBeLessThan(65 * 60_000);
  });

  it("caso 8 — retry sem retry_at: aplica backoff (não busy-loopa), attempts inalterado", () => {
    const row = rowState(idRetryNoBackoff);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_at).not.toBeNull();
    expect(new Date(row.next_attempt_at!).getTime()).toBeGreaterThan(Date.now());
  });
});
