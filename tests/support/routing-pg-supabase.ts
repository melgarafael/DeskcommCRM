import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
/** Ponte PostgREST→SQL apenas do harness efêmero. As regras, RPCs e tabelas são reais.
 * Não implementa HTTP Supabase/RLS de sessão; ACL humana é provada por SET ROLE. */
export function routingPgSupabase(pool: pg.Pool) {
  const errors: unknown[] = [];
  const identifier = (s: string) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw Error(`identificador de teste inválido: ${s}`);
    return `"${s}"`;
  };
  type Result = { data: unknown; error: unknown };
  class Query implements PromiseLike<Result> {
    mode = "select";
    data: Record<string, unknown> = {};
    conditions: Array<[string, string, unknown]> = [];
    one = false;
    limitN: number | undefined;
    cols = "*";
    ordering: string[] = [];
    constructor(readonly table: string) {}
    select(cols = "*") {
      this.cols = cols;
      return this;
    }
    insert(data: Record<string, unknown>) {
      this.mode = "insert";
      this.data = data;
      return this;
    }
    update(data: Record<string, unknown>) {
      this.mode = "update";
      this.data = data;
      return this;
    }
    delete() {
      this.mode = "delete";
      return this;
    }
    eq(k: string, v: unknown) {
      this.conditions.push([k, "=", v]);
      return this;
    }
    neq(k: string, v: unknown) {
      this.conditions.push([k, "<>", v]);
      return this;
    }
    is(k: string, v: unknown) {
      this.conditions.push([k, "is", v]);
      return this;
    }
    in(k: string, v: unknown[]) {
      this.conditions.push([k, "in", v]);
      return this;
    }
    limit(n: number) {
      this.limitN = n;
      return this;
    }
    lte(k: string, v: unknown) { this.conditions.push([k, "<=", v]); return this; }
    or(expression: string) {
      const match = /^next_attempt_at.is.null,next_attempt_at.lte.(.+)$/.exec(expression);
      if (!match) throw new Error("unsupported routing OR");
      this.conditions.push(["next_attempt_at", "null_or_lte", match[1]]); return this;
    }
    order(key: string, opts?: { ascending?: boolean }) {
      this.ordering.push(`${identifier(key)} ${opts?.ascending === false ? "desc" : "asc"}`); return this;
    }
    maybeSingle() {
      this.one = true;
      return this.execute();
    }
    single() {
      this.one = true;
      return this.execute();
    }
    then<A = Result, B = never>(
      yes?: ((value: Result) => A | PromiseLike<A>) | null,
      no?: ((reason: unknown) => B | PromiseLike<B>) | null,
    ): PromiseLike<A | B> {
      return this.execute().then(yes, no);
    }
    async execute(): Promise<Result> {
      try {
        const values: unknown[] = [];
        const param = (v: unknown) => {
          values.push(
            typeof v === "object" && v !== null && !Array.isArray(v) ? JSON.stringify(v) : v,
          );
          return `$${values.length}`;
        };
        const field = (s: string) => {
          const match = /^([a-z_]+)->>([a-z_]+)$/.exec(s);
          return match ? `${identifier(match[1]!)}->>'${match[2]}'` : identifier(s);
        };
        const where = this.conditions.length
          ? " where " +
            this.conditions
              .map(([k, op, v]) =>
                op === "null_or_lte" ? `(${field(k)} is null or ${field(k)}<=${param(v)})` : op === "is"
                  ? `${field(k)} is null`
                  : op === "in"
                    ? `${field(k)}=any(${param(v)})`
                    : `${field(k)}${op}${param(v)}`,
              )
              .join(" and ")
          : "";
        const table = identifier(this.table);
        let sql: string;
        if (this.mode === "select")
          sql = `select * from ${table}${where}${this.ordering.length ? ` order by ${this.ordering.join(",")}` : ""}${this.limitN === undefined ? "" : ` limit ${this.limitN}`}`;
        else if (this.mode === "insert") {
          const entries = Object.entries(this.data).filter(([, v]) => v !== undefined);
          sql = `insert into ${table}(${entries.map(([k]) => identifier(k)).join(",")}) values(${entries.map(([, v]) => param(v)).join(",")}) returning *`;
        } else if (this.mode === "update")
          sql = `update ${table} set ${Object.entries(this.data)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${identifier(k)}=${param(v)}`)
            .join(",")}${where} returning *`;
        else sql = `delete from ${table}${where} returning *`;
        const result = await pool.query(
          `with result as (${sql}) select to_jsonb(result) r from result`,
          values,
        );
        const rows = result.rows.map((r) => r.r);
        if (this.mode === "select" && this.cols.includes("("))
          for (const row of rows)
            for (const [fk, t] of [
              ["contact_id", "contacts"],
              ["channel_session_id", "channel_sessions"],
              ["current_demanda_id", "demandas"],
            ] as const)
              if (row[fk] && this.cols.includes(`${fk}(`)) {
                row[t] =
                  (
                    await pool.query(
                      `select to_jsonb(t) r from ${identifier(t)} t where id=$1 and organization_id=$2`,
                      [row[fk], row.organization_id],
                    )
                  ).rows[0]?.r ?? null;
              }
        return { data: this.one ? (rows[0] ?? null) : rows, error: null };
      } catch (error) {
        errors.push(error);
        return { data: null, error };
      }
    }
  }
  const client = {
    from: (table: string) => new Query(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      try {
        const entries = Object.entries(args);
        const result = await pool.query(
          `select ${identifier(name)}(${entries.map(([k], i) => `${identifier(k)}=>$${i + 1}`).join(",")}) r`,
          entries.map(([, v]) => (typeof v === "object" && v !== null ? JSON.stringify(v) : v)),
        );
        return { data: result.rows[0]?.r, error: null };
      } catch (error) {
        errors.push(error);
        return { data: null, error };
      }
    },
  } as unknown as SupabaseClient;
  return { client, errors };
}
