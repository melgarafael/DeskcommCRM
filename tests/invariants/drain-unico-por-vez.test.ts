import { beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";

import { registerHandler, type EventRow, type HandlerResult } from "@/lib/event-log/dispatcher";
import { drenarSozinho } from "@/lib/event-log/trava-do-dreno";
import { GOV_ORG, seedGov, sql, lastLine } from "./gov-helpers";

/**
 * UM DRENO POR VEZ — a trava de passada do `event_log` (issue #2235).
 *
 * ## O que a issue mede, e o que este arquivo mede
 *
 * `app/api/v1/cron/event-log-drain` é armado por DOIS agendadores na mesma
 * instalação: o cron do contêiner (`docker/scheduler/entrypoint.sh:59`) e o
 * crontab do host do kit (`hostgator-setup-kit/_common.sh`,
 * `setup_event_log_drain_cron`). Medido na issue: com as abas fechadas, ~62% das
 * chamadas `service_role` ao PostgREST eram na `event_log` — duas varreduras de
 * até 50 linhas por minuto onde uma bastava.
 *
 * ⚠️ HONESTIDADE SOBRE O QUE DUPLICA HOJE: o claim por linha de
 * `lib/event-log/drain.ts` já é um `update … where id = $1 and status =
 * 'pending'`, isto é, ATÔMICO. A MESMA linha não é executada duas vezes por
 * dois drenos — medido aqui no caso "cada evento uma vez", que passa antes e
 * depois do conserto. O que os dois agendadores duplicam é a PASSADA: as duas
 * varrem o mesmo lote, as duas fazem as consultas de organização, as duas
 * tentam reivindicar as mesmas linhas — e é essa passada duplicada que a trava
 * corta (e o egress da issue). A trava também fecha a classe de efeito em dobro
 * que o claim de linha não cobre: handlers com efeito colateral NÃO idempotente
 * disputados por duas passadas (a família do #880).
 *
 * Por isso a asserção que separa antes/depois é "só UMA passada trabalha": com a
 * trava, a segunda responde `pulado: "outro_dreno"` com todos os contadores
 * zerados e não toca a fila.
 *
 * ## Harness
 *
 * `scripts/test-db.sh` sobe SÓ um Postgres cru (sem PostgREST), então o
 * `SupabaseClient` é o dublê da suíte (`fakeAdminClient`, mesmo shape do
 * `tests/invariants/event-log-drain.test.ts`) traduzindo a cadeia do drain para
 * SQL via `docker exec psql`. A TRAVA, porém, é real: o teste injeta um
 * `pg.Pool` de verdade apontando para o mesmo container (porta publicada em
 * `TEST_DB_PORT`), então `pg_try_advisory_lock` roda no Postgres — é o produto,
 * não um mock de trava.
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

type FilterOp = "eq" | "neq" | "lte" | "lt" | "in" | "or";
interface Filter {
  op: FilterOp;
  col?: string;
  val?: unknown;
  raw?: string;
}

/**
 * Dublê mínimo do shape que `drain.ts` usa. Copiado do invariante irmão
 * (`event-log-drain.test.ts`) de propósito: `tests/invariants/**` é suíte
 * compartilhada e o harness existente não é exportado — duplicar o dublê evita
 * mexer no arquivo alheio só para reusar dez métodos.
 */
class FakeQuery implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private mode: "select" | "update" | null = null;
  private selectCols = "*";
  private selectAfterUpdate = false;
  private updateData: Record<string, unknown> | null = null;
  private filtros: Filter[] = [];
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
    this.filtros.push({ op: "eq", col, val });
    return this;
  }

  neq(col: string, val: unknown): this {
    this.filtros.push({ op: "neq", col, val });
    return this;
  }

  lte(col: string, val: unknown): this {
    this.filtros.push({ op: "lte", col, val });
    return this;
  }

  lt(col: string, val: unknown): this {
    this.filtros.push({ op: "lt", col, val });
    return this;
  }

  in(col: string, val: unknown[]): this {
    this.filtros.push({ op: "in", col, val });
    return this;
  }

  or(raw: string): this {
    this.filtros.push({ op: "or", raw });
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
    if (!this.filtros.length) return "";
    const clausulas = this.filtros.map((f) => {
      if (f.op === "eq") return `${f.col} = ${sqlLiteral(f.val)}`;
      if (f.op === "neq") return `${f.col} <> ${sqlLiteral(f.val)}`;
      if (f.op === "lte") return `${f.col} <= ${sqlLiteral(f.val)}`;
      if (f.op === "lt") return `${f.col} < ${sqlLiteral(f.val)}`;
      if (f.op === "in") return `${f.col} in (${(f.val as unknown[]).map(sqlLiteral).join(",")})`;
      // PostgREST "col.is.null,col.lte.<iso>" — o único shape que drain.ts emite.
      const partes = f.raw!.split(",").map((p) => {
        const [col, kind, ...resto] = p.split(".");
        const arg = resto.join(".");
        if (kind === "is" && arg === "null") return `${col} is null`;
        if (kind === "lte") return `${col} <= ${sqlLiteral(arg)}`;
        throw new Error(`fakeAdminClient: cláusula .or() não suportada: ${p}`);
      });
      return `(${partes.join(" or ")})`;
    });
    return ` where ${clausulas.join(" and ")}`;
  }

  private toSql(): string {
    if (this.mode === "select") {
      let q = `select ${this.selectCols} from public.${this.table}${this.buildWhere()}`;
      if (this.orderCol) q += ` order by ${this.orderCol} ${this.orderAsc ? "asc" : "desc"}`;
      if (this.limitN !== undefined) q += ` limit ${this.limitN}`;
      return q;
    }
    if (this.mode === "update") {
      const sets = Object.entries(this.updateData!)
        .map(([k, v]) => `${k} = ${sqlLiteral(v)}`)
        .join(", ");
      let q = `update public.${this.table} set ${sets}${this.buildWhere()}`;
      if (this.selectAfterUpdate) q += ` returning ${this.selectCols}`;
      return q;
    }
    throw new Error("fakeAdminClient: nenhum modo (.select()/.update()) definido");
  }

  private async execute(): Promise<{ data: unknown; error: { message: string } | null }> {
    try {
      const precisaDeLinhas = this.mode === "select" || this.selectAfterUpdate;
      if (precisaDeLinhas) {
        const interno = this.toSql();
        const envolto =
          this.mode === "update"
            ? `with w as (${interno}) select coalesce(json_agg(w), '[]') from w;`
            : `select coalesce(json_agg(t), '[]') from (${interno}) t;`;
        return { data: JSON.parse(sql(envolto)), error: null };
      }
      sql(`${this.toSql()};`);
      return { data: null, error: null };
    } catch (err) {
      return { data: null, error: { message: (err as Error).message } };
    }
  }

  then<T1 = { data: unknown; error: { message: string } | null }, T2 = never>(
    onfulfilled?: ((v: { data: unknown; error: { message: string } | null }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((r: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

function fakeAdminClient(): SupabaseClient {
  return { from: (table: string) => new FakeQuery(table) } as unknown as SupabaseClient;
}

/** A conexão DIRETA — a mesma que a trava usa em produção (`SUPABASE_DB_URL`). */
const pool = new pg.Pool({
  host: "127.0.0.1",
  port: Number(process.env.TEST_DB_PORT ?? 54329),
  user: "postgres",
  password: "postgres",
  database: "postgres",
  max: 4,
});

function emitir(tipo: string): string {
  const out = sql(
    `select public.emit_event('${tipo}', 'test', null, '{}'::jsonb, '{}'::jsonb, '${GOV_ORG}');`,
  );
  return lastLine(out);
}

function estadoDaFila(ids: string[]): Record<string, string> {
  const out = sql(
    `select coalesce(json_agg(t), '[]') from (
       select id, status from public.event_log
        where id in (${ids.map((i) => `'${i}'`).join(",")})
     ) t;`,
  );
  const linhas = JSON.parse(out) as Array<{ id: string; status: string }>;
  return Object.fromEntries(linhas.map((l) => [l.id, l.status]));
}

const execucoes: string[] = [];
let aoEntrarNoHandler: (() => void) | null = null;

const TIPO = "test.drain_unico_por_vez";
registerHandler({
  key: "test-drain-unico-por-vez",
  naOrgParada: "roda",
  events: [TIPO],
  async handle(row: EventRow): Promise<HandlerResult> {
    execucoes.push(row.id);
    const sinal = aoEntrarNoHandler;
    aoEntrarNoHandler = null;
    sinal?.();
    // Deixa a outra passada tentar a trava NO MEIO desta — é o que faz o teste
    // medir concorrência de verdade em vez de duas chamadas em sequência.
    await new Promise((r) => setTimeout(r, 50));
    return { consumer_key: "test-drain-unico-por-vez", status: "ok" };
  },
});

beforeAll(() => {
  seedGov();
});

describe("event_log: um dreno por vez (trava de passada no banco)", () => {
  it("(a) duas passadas concorrentes: cada evento executa UMA vez e só uma passada trabalha", async () => {
    const ids = [emitir(TIPO), emitir(TIPO), emitir(TIPO)];
    execucoes.length = 0;

    let sinal!: () => void;
    const entrouNoHandler = new Promise<void>((r) => (sinal = r));
    aoEntrarNoHandler = sinal;

    // A passada 1 pega a trava e entra no handler; é AÍ que a passada 2 chega.
    const primeira = drenarSozinho(fakeAdminClient(), { pool });
    await entrouNoHandler;
    const segunda = await drenarSozinho(fakeAdminClient(), { pool });
    const resumoPrimeira = await primeira;

    // (a.1) cada evento processado UMA vez
    expect([...execucoes].sort()).toEqual([...ids].sort());
    expect(estadoDaFila(ids), "as três linhas devem terminar em done").toEqual(
      Object.fromEntries(ids.map((i) => [i, "done"])),
    );

    // (a.2) só UMA passada trabalhou — a outra pulou
    expect(segunda, "a segunda passada deveria devolver o campo de pulo").toEqual({
      ok: true,
      pulado: "outro_dreno",
    });
    expect(resumoPrimeira, "a primeira passada processou o lote").toMatchObject({
      scanned: 3,
      done: 3,
    });
  });

  it("(b) quem não pega a trava não tem efeito nenhum: contadores zerados", async () => {
    const ids = [emitir(TIPO), emitir(TIPO)];
    execucoes.length = 0;

    let sinal!: () => void;
    const entrouNoHandler = new Promise<void>((r) => (sinal = r));
    aoEntrarNoHandler = sinal;

    const primeira = drenarSozinho(fakeAdminClient(), { pool });
    await entrouNoHandler;
    const segunda = await drenarSozinho(fakeAdminClient(), { pool });
    await primeira;

    // O pulo é um resumo SÓ com o campo de pulo: nada de scanned/done/failed.
    expect(Object.keys(segunda as object).sort()).toEqual(["ok", "pulado"]);
    expect(execucoes).toHaveLength(ids.length);
    expect(estadoDaFila(ids)).toEqual(Object.fromEntries(ids.map((i) => [i, "done"])));
  });

  it("(c) fila vazia responde o resumo normal (200), sem campo de pulo", async () => {
    // Todos os eventos deste tipo já terminaram em `done` nos casos acima, e o
    // registry deste arquivo só tem o handler de TIPO — então a passada varre
    // zero linhas e devolve o resumo normal. A rota o embrulha em `ok()`, que é
    // 200: fila vazia nunca foi nem pode virar erro para os dois crons.
    const resumo = await drenarSozinho(fakeAdminClient(), { pool });
    expect(resumo).not.toHaveProperty("pulado");
    expect(resumo).toMatchObject({ scanned: 0, done: 0, retried: 0, failed: 0, dead: 0 });
  });

  it("(d) a trava é LIBERADA ao fim da passada: a passada seguinte volta a pegar", async () => {
    const id = emitir(TIPO);
    execucoes.length = 0;
    const resumo = await drenarSozinho(fakeAdminClient(), { pool });
    expect(resumo).not.toHaveProperty("pulado");
    expect(execucoes).toEqual([id]);

    // E, solta a trava, uma conexão de fora consegue pegá-la.
    const fora = await pool.connect();
    try {
      const { rows } = await fora.query<{ locked: boolean }>(
        "select pg_try_advisory_lock(hashtextextended('event-log:drain', 0)) as locked",
      );
      expect(rows[0]?.locked, "a passada terminou e deixou a trava presa").toBe(true);
      await fora.query("select pg_advisory_unlock(hashtextextended('event-log:drain', 0))");
    } finally {
      fora.release();
    }
  });
});
