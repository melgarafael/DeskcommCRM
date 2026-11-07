import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * O GATILHO "NEGÓCIO ALTERADO" DISPARA — medido contra Postgres de verdade
 * (issue #1749, precedente da 0417 com `message.failed`).
 *
 * ## O defeito que este arquivo congela
 *
 * `updateLeadHandler` (PATCH /api/v1/leads/[id]) emite `lead.updated` com
 * `payload: { fields }` desde a wave 6 — os NOMES das colunas que a edição
 * mudou. Só que o tipo estava na lista de REGISTRO da `fn_event_log_e_registro`
 * (0239): o trigger `trg_event_log_marca_registro` o fazia NASCER `done`, o
 * dreno (`status='pending'` E `event_type in (handlers)`) nunca o selecionava e
 * nenhuma regra reagia a "o valor foi preenchido", "a data prevista mudou".
 *
 * Sem a migration da 1749, o PRIMEIRO caso deste arquivo reprova aqui:
 *
 *   expect(row(status)).toBe("pending")   // ← era "done"
 *
 * Esse é o RED que o PR cita. O resto do arquivo só tem valor com ele verde,
 * porque um evento que nasce `done` não é entregue a ninguém.
 *
 * ## O que ele prova, e com que peças REAIS
 *
 *   A. a edição do negócio sai pelo handler REAL (`updateLeadHandler`) com o
 *      contexto REAL de motor (`@/lib/supabase/admin` é o dublê, mas quem
 *      monta o payload é o código de produção), a linha NASCE `pending`, e o
 *      dreno REAL (`drainEventLog`) a consome e a regra dispara — o caminho
 *      inteiro, não a peça;
 *   B. alteração de OUTRO campo não dispara a regra: a condição
 *      `campo_alterado` pergunta à lista de nomes, não "se o negócio mudou";
 *   C. o payload do evento NÃO carrega valor de campo — só nomes. É o §9 do
 *      briefing (nenhuma PII nova em log/evento/reason) e a razão de a condição
 *      ter sido desenhada sobre `fields`;
 *   D. o motor só aceita `lead.updated` como gatilho porque ele está em
 *      `ENTIDADE_ESPERADA_POR_GATILHO` com `crm_lead` — o mesmo `entity_kind`
 *      que o handler grava (sem isso o evento era descartado com
 *      `entity_kind_mismatch`, sem erro nenhum).
 *
 * ## O que este arquivo NÃO mede
 *
 *  - VOLUME: quantas edições uma instalação grande faz por hora. O custo por
 *    evento (uma consulta de regras) não foi medido em produção;
 *  - a TELA: o `RuleEditor` é coberto por `lib/schemas/webhooks.test.ts` (o par
 *    gatilho × condição) e pelo teste de i18n, não por este harness;
 *  - o caminho `caused_by_rule` (anti-laço) já tem invariante próprio.
 *
 * ## Por que o dublê e não PostgREST
 *
 * O harness (`scripts/test-db.sh`) sobe só um Postgres cru — sem PostgREST, sem
 * HTTP. `fakeAdmin()` traduz o shape que o motor e o dreno usam
 * (`.from().select()/.update()/.insert()`, `eq/neq/in/lt/lte/gt/gte/or`,
 * `order/limit`, `maybeSingle`, `rpc`) para SQL via o mesmo `sql()` dos
 * invariantes irmãos (`tests/invariants/event-log-drain.test.ts`,
 * `webhooks-trigger-events.test.ts`). Ele não testa a tradução do PostgREST:
 * testa o comportamento contra o banco.
 *
 * Cada arquivo usa a PRÓPRIA organização (`a1749000-…`), e o dreno roda
 * ESCOPADO nela: o Postgres é compartilhado pelos invariantes, e um dreno
 * global consumiria evento de outro arquivo (e rodaria a regra dele).
 */

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdmin() }));

import { updateLeadHandler } from "@/app/api/v1/leads/_handler";
import { registerAction } from "@/lib/automation/actions";
import { AUTOMATION_CONSUMER_KEY } from "@/lib/automation/engine";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";
import { drainEventLog } from "@/lib/event-log/drain";
import { getRegisteredHandlers } from "@/lib/event-log/dispatcher";
import { ENTIDADE_ESPERADA_POR_GATILHO } from "@/lib/schemas/webhooks";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { sql, lastLine } from "./gov-helpers";

// ─── fixture: organização própria, para o dreno escopado não ver mais ninguém ──

const ORG = "a1749000-0000-4000-8000-000000000001";
const PIPELINE = "a1749000-5555-4000-8000-000000000001";
const STAGE = "a1749000-5555-4000-8000-000000000002";
const CONTACT = "a1749000-3333-4000-8000-000000000001";
const LEAD = "a1749000-6666-4000-8000-000000000001";
const RULE = "a1749000-1111-4000-8000-000000000001";
const RULE_OUTRO_CAMPO = "a1749000-1111-4000-8000-000000000002";

/** A execução da regra, para o contador do caso B. */
let acoesExecutadas = 0;

registerAction({
  type: "fake_ok_1749",
  async execute() {
    acoesExecutadas += 1;
    return { type: "fake_ok_1749", status: "success" };
  },
});

function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) {
    // `consumed_by` é text[]; array de objeto (jsonb) cai no ramo de baixo.
    if (v.some((x) => x !== null && typeof x === "object")) return `${sqlString(JSON.stringify(v))}::jsonb`;
    return `ARRAY[${v.map((x) => sqlString(String(x))).join(",")}]::text[]`;
  }
  if (typeof v === "object") return `${sqlString(JSON.stringify(v))}::jsonb`;
  return sqlString(String(v));
}

type QResult = { data: unknown; error: { message: string } | null };

type FilterOp = "eq" | "neq" | "in" | "gt" | "gte" | "lt" | "lte" | "or";
interface Filter {
  op: FilterOp;
  col?: string;
  val?: unknown;
  raw?: string;
}

/** Double mínimo do PostgrestQueryBuilder com o shape do MOTOR + do DRENO. */
class FakeQuery implements PromiseLike<QResult> {
  private mode: "select" | "insert" | "update" | null = null;
  private selectCols = "*";
  private selectAfterMutation = false;
  private mutationData: Record<string, unknown> | null = null;
  private insertOpts: { onConflict?: string; ignoreDuplicates?: boolean } | null = null;
  private filters: Filter[] = [];
  private orderCol?: string;
  private orderAsc = true;
  private limitN?: number;

  constructor(private table: string) {}

  select(cols: string): this {
    if (this.mode === "insert" || this.mode === "update") {
      this.selectAfterMutation = true;
    } else {
      this.mode = "select";
    }
    this.selectCols = cols;
    return this;
  }

  insert(data: Record<string, unknown>, opts?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.mode = "insert";
    this.mutationData = data;
    this.insertOpts = opts ?? null;
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

  neq(col: string, val: unknown): this {
    this.filters.push({ op: "neq", col, val });
    return this;
  }

  in(col: string, val: unknown[]): this {
    this.filters.push({ op: "in", col, val });
    return this;
  }

  gt(col: string, val: unknown): this {
    this.filters.push({ op: "gt", col, val });
    return this;
  }

  gte(col: string, val: unknown): this {
    this.filters.push({ op: "gte", col, val });
    return this;
  }

  lt(col: string, val: unknown): this {
    this.filters.push({ op: "lt", col, val });
    return this;
  }

  lte(col: string, val: unknown): this {
    this.filters.push({ op: "lte", col, val });
    return this;
  }

  /** `next_attempt_at.is.null,next_attempt_at.lte.<iso>` — a única forma do dreno. */
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

  async maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }> {
    const { data, error } = await this.execute();
    if (error) return { data: null, error };
    const rows = (data as Array<Record<string, unknown>>) ?? [];
    return { data: rows[0] ?? null, error: null };
  }

  private where(prefix = ""): string {
    if (!this.filters.length) return "";
    const clausulas = this.filters.map((f) => {
      if (f.op === "eq") return `${prefix}${f.col} = ${sqlLiteral(f.val)}`;
      if (f.op === "neq") return `${prefix}${f.col} <> ${sqlLiteral(f.val)}`;
      if (f.op === "gt") return `${prefix}${f.col} > ${sqlLiteral(f.val)}`;
      if (f.op === "gte") return `${prefix}${f.col} >= ${sqlLiteral(f.val)}`;
      if (f.op === "lt") return `${prefix}${f.col} < ${sqlLiteral(f.val)}`;
      if (f.op === "lte") return `${prefix}${f.col} <= ${sqlLiteral(f.val)}`;
      if (f.op === "in")
        return `${prefix}${f.col} in (${(f.val as unknown[]).map(sqlLiteral).join(", ")})`;
      // `or` cru do PostgREST: `col.is.null,col.lte.<iso>` (dreno) e
      // `is_active.eq.true,is_active.is.null` (motor). Só o que eles emitem.
      const partes = (f.raw ?? "").split(",").map((p) => {
        const [col, tipo, ...resto] = p.split(".");
        const arg = resto.join(".");
        if (tipo === "is" && arg === "null") return `${prefix}${col} is null`;
        if (tipo === "eq") return `${prefix}${col} = ${sqlLiteral(arg)}`;
        if (tipo === "lte") return `${prefix}${col} <= ${sqlLiteral(arg)}`;
        throw new Error(`fakeAdmin: cláusula .or() não suportada: ${p}`);
      });
      return `(${partes.join(" or ")})`;
    });
    return ` where ${clausulas.join(" and ")}`;
  }

  private montarSql(): string {
    if (this.mode === "select") {
      let q = `select ${this.selectCols} from public.${this.table}${this.where()}`;
      if (this.orderCol) q += ` order by ${this.orderCol} ${this.orderAsc ? "asc" : "desc"}`;
      if (this.limitN !== undefined) q += ` limit ${this.limitN}`;
      return q;
    }
    if (this.mode === "insert") {
      const entries = Object.entries(this.mutationData!).filter(([, v]) => v !== undefined);
      const q = `insert into public.${this.table} (${entries.map(([k]) => k).join(", ")}) values (${entries
        .map(([, v]) => sqlLiteral(v))
        .join(", ")})${
        this.insertOpts?.ignoreDuplicates && this.insertOpts.onConflict
          ? ` on conflict (${this.insertOpts.onConflict}) do nothing`
          : ""
      }`;
      return q;
    }
    if (this.mode === "update") {
      const sets = Object.entries(this.mutationData!)
        .map(([k, v]) => `${k} = ${sqlLiteral(v)}`)
        .join(", ");
      return `update public.${this.table} set ${sets}${this.where()}`;
    }
    throw new Error("fakeAdmin: nenhum modo definido");
  }

  private async execute(): Promise<QResult> {
    try {
      const precisaLinhas = this.mode === "select" || this.selectAfterMutation;
      const inner = this.montarSql();
      if (!precisaLinhas) {
        sql(`${inner};`);
        return { data: null, error: null };
      }
      const returning = this.selectAfterMutation && this.mode !== "select";
      const envolto = returning
        ? `with w as (${inner} returning ${this.selectCols}) select coalesce(json_agg(w), '[]') from w;`
        : `select coalesce(json_agg(t), '[]') from (${inner}) t;`;
      // `json_agg` de linha multi-coluna quebra linha entre campos: parse do
      // texto INTEIRO, não da última linha (como o dreno irmão já documenta).
      return { data: JSON.parse(sql(envolto) || "[]"), error: null };
    } catch (err) {
      return { data: null, error: { message: (err as Error).message } };
    }
  }

  then<T1 = QResult, T2 = never>(
    onfulfilled?: ((value: QResult) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

function fakeAdmin(): SupabaseClient {
  return {
    from: (table: string) => new FakeQuery(table),
    // O handler REAL faz `await supabase.auth.getUser().catch(...)` — um `.catch`
    // não protege de `undefined.getUser` (TypeError síncrono). O dublê devolve
    // "sem usuário": o caminho do autor anônimo (chave de API sem usuário) e o
    // `atual` do resultado, sem inventar ator.
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    rpc: (name: string, params: Record<string, unknown>): Promise<QResult> => {
      return (async () => {
        if (name !== "emit_event") throw new Error(`fakeAdmin: rpc não suportada: ${name}`);
        const p = params as Record<string, string | null>;
        try {
          sql(
            `select public.emit_event(${sqlString(p.p_event_type!)}, ${sqlString(
              p.p_entity_kind!,
            )}, ${p.p_entity_id ? sqlString(p.p_entity_id) : "null"}, ${sqlString(
              JSON.stringify(p.p_payload),
            )}::jsonb, ${sqlString(JSON.stringify(p.p_metadata))}::jsonb, ${sqlString(
              p.p_organization_id!,
            )});`,
          );
          return { data: null, error: null };
        } catch (err) {
          return { data: null, error: { message: (err as Error).message } };
        }
      })();
    },
  } as unknown as SupabaseClient;
}

const ctx: HandlerCtx = {
  organization_id: ORG,
  // `Actor` de usuário exige id string; o id é sintético de propósito (catraca
  // de identificador de produção) e só serve para a correlação do audit.
  actor: { type: "user", id: "00000000-0000-4000-8000-000000000174" },
  requestId: "inv-1749-request",
};

function estadoDoEvento(id: string): {
  status: string;
  consumed_by: string[];
  payload: Record<string, unknown>;
} {
  const out = sql(
    `select coalesce(json_agg(t), '[]') from (
       select status, consumed_by, payload from public.event_log where id = ${sqlString(id)}
     ) t;`,
  );
  const linhas = JSON.parse(out || "[]") as Array<{
    status: string;
    consumed_by: string[] | null;
    payload: Record<string, unknown>;
  }>;
  if (!linhas.length) throw new Error(`event_log ${id} não existe`);
  const l = linhas[0]!;
  return { status: l.status, consumed_by: l.consumed_by ?? [], payload: l.payload };
}

function execucoesDaRegra(regra: string): Array<{ status: string; event_id: string }> {
  const out = sql(
    `select coalesce(json_agg(t), '[]') from (
       select status, event_id from public.automation_rule_runs
        where rule_id = ${sqlString(regra)} order by created_at
     ) t;`,
  );
  return JSON.parse(out || "[]");
}

function ultimoEventoLeadUpdated(): string {
  return lastLine(
    sql(
      `select id from public.event_log
        where event_type = 'lead.updated' and organization_id = ${sqlString(ORG)}
        order by created_at desc, id desc limit 1;`,
    ),
  );
}

/** O dreno ESCOPADO na organização deste arquivo — só ele toca nas linhas dela. */
async function drenar() {
  return drainEventLog(fakeAdmin(), {
    limit: 50,
    escopo: { organizationId: ORG, handlers: [AUTOMATION_CONSUMER_KEY] },
  });
}

beforeAll(() => {
  ensureHandlersRegistered();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'inv-1749', 'Inv 1749 Org', 'Inv 1749')
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPELINE}', '${ORG}', 'Inv 1749', 'inv-1749')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${STAGE}', '${ORG}', '${PIPELINE}', 'Novo', 'novo', 1000)
      on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTACT}', '${ORG}', 'Contato Inv 1749')
      on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id)
      values ('${LEAD}', '${ORG}', '${PIPELINE}', '${STAGE}', 'Negócio Inv 1749', '${CONTACT}')
      on conflict do nothing;
    insert into public.automation_rules (id, organization_id, name, trigger_event, conditions, actions, is_active)
      values
        -- A regra do aceite da issue: dispara quando a DATA PREVISTA mudou.
        ('${RULE}', '${ORG}', 'Data prevista mudou', 'lead.updated',
          '[{"field":"event.fields","op":"campo_alterado","value":"expected_close_date"}]'::jsonb,
          '[{"type":"fake_ok_1749"}]'::jsonb, true),
        -- Irmã de controle: mesma forma, outro campo. Serve para provar que a
        -- condição olha o NOME, e não "se o negócio foi editado".
        ('${RULE_OUTRO_CAMPO}', '${ORG}', 'Título mudou', 'lead.updated',
          '[{"field":"event.fields","op":"campo_alterado","value":"title"}]'::jsonb,
          '[{"type":"fake_ok_1749"}]'::jsonb, true)
      on conflict do nothing;
  `);
});

afterAll(() => {
  // Os eventos e as execuções são DESTA organização; apagar por organização é
  // seguro aqui porque o namespace é só deste arquivo (ao contrário do irmão,
  // que reusa a GOV_ORG).
  sql(`
    delete from public.automation_rule_runs where organization_id = ${sqlString(ORG)};
    delete from public.automation_rules where organization_id = ${sqlString(ORG)};
    delete from public.event_log where organization_id = ${sqlString(ORG)};
    delete from public.crm_leads where organization_id = ${sqlString(ORG)};
    delete from public.contacts where organization_id = ${sqlString(ORG)};
    delete from public.crm_stages where organization_id = ${sqlString(ORG)};
    delete from public.crm_pipelines where organization_id = ${sqlString(ORG)};
    delete from public.organizations where id = ${sqlString(ORG)};
  `);
});

describe("lead.updated é gatilho de verdade (#1749)", () => {
  it("a edição do negócio nasce `pending` e o dreno a consome até a regra disparar", async () => {
    // A edição sai pelo handler REAL: o payload que este teste lê depois é o que
    // o produto grava, não um objeto que eu montei para passar.
    await updateLeadHandler(fakeAdmin(), ctx, LEAD, { expected_close_date: "2027-03-15" });

    const evento = ultimoEventoLeadUpdated();
    expect(evento).toBeTruthy();

    // ⭐ O RED do PR: antes da migration da 1749 esta linha nascia `done`
    // (fn_event_log_e_registro devolvia true para 'lead.updated') e o dreno
    // nunca a selecionava.
    expect(
      estadoDoEvento(evento).status,
      "o lead.updated nasceu fora da fila — o tipo voltou para a lista de registro?",
    ).toBe("pending");

    // O dreno filtrou POR ESTE TIPO (e não por acaso): o registry real assina.
    const assinados = getRegisteredHandlers().flatMap((h) => h.events);
    expect(assinados, "o handler de automação não assina lead.updated").toContain("lead.updated");
    expect(ENTIDADE_ESPERADA_POR_GATILHO["lead.updated"]).toBe("crm_lead");

    const resumo = await drenar();
    expect(resumo.scanned, "o dreno não pegou o evento — ele não estava na fila").toBeGreaterThan(0);

    const depois = estadoDoEvento(evento);
    expect(depois.status, "o evento não foi drenado").toBe("done");
    expect(depois.consumed_by).toContain(AUTOMATION_CONSUMER_KEY);

    // A REGRA DISPAROU — e foi a da data prevista, não a irmã.
    const execucoes = execucoesDaRegra(RULE);
    expect(execucoes.length, "a regra do campo alterado não rodou").toBe(1);
    expect(execucoes[0]!.event_id).toBe(evento);
    expect(execucoes[0]!.status).toBe("success");
    expect(execucoesDaRegra(RULE_OUTRO_CAMPO).length, "a regra do OUTRO campo rodou").toBe(0);
  });

  it("alterar OUTRO campo entrega o evento e NÃO dispara a regra da data", async () => {
    const antes = execucoesDaRegra(RULE).length;
    const okAntes = acoesExecutadas;

    await updateLeadHandler(fakeAdmin(), ctx, LEAD, { title: "Negócio Inv 1749 (renomeado)" });
    const evento = ultimoEventoLeadUpdated();
    expect(estadoDoEvento(evento).payload.fields).toEqual(["title"]);

    await drenar();

    expect(estadoDoEvento(evento).status).toBe("done");
    expect(execucoesDaRegra(RULE).length, "a regra da data disparou numa edição de título").toBe(antes);
    // E a irmã (condição `title`) rodou: o evento não foi engolido, foi FILTRADO.
    expect(execucoesDaRegra(RULE_OUTRO_CAMPO).length).toBe(1);
    expect(acoesExecutadas, "a ação da regra de título não executou").toBe(okAntes + 1);
  });

  it("o evento não carrega VALOR de campo — só os nomes (§9)", async () => {
    const TITULO = "Negócio Sigiloso 9137";
    await updateLeadHandler(fakeAdmin(), ctx, LEAD, {
      title: TITULO,
      value_cents: 9_876_543,
    });

    const { payload } = estadoDoEvento(ultimoEventoLeadUpdated());
    expect(payload.fields).toEqual(expect.arrayContaining(["title", "value_cents"]));

    // A asserção que a issue pede: NENHUM valor de campo no aviso. O título e o
    // valor são os dois campos de PII que acabaram de mudar.
    const serializado = JSON.stringify(payload);
    expect(serializado, "o payload do evento carrega o TÍTULO (PII)").not.toContain("Sigiloso");
    expect(serializado, "o payload do evento carrega o VALOR do negócio").not.toContain("9876543");
    expect(serializado, "o payload do evento carrega o valor formatado").not.toContain("9.876");

    // E o que ele carrega é NOME: cada item de `fields` é uma coluna, não um
    // trecho de texto livre.
    for (const campo of payload.fields as string[]) {
      expect(campo).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("o tipo não é registro: `fn_event_log_e_registro('lead.updated')` é falso", () => {
    // A régua do banco, lida direto — se a migration não fosse aplicada no
    // teste, é aqui que o motivo aparece sem depender do dreno.
    expect(lastLine(sql(`select public.fn_event_log_e_registro('lead.updated');`))).toBe("f");
    // E a prova de que a lista continua servindo para os outros: um tipo de
    // registro segue `done` no nascimento.
    expect(lastLine(sql(`select public.fn_event_log_e_registro('lead.bulk_tagged');`))).toBe("t");
  });
});
