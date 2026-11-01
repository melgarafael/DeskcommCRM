import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { ensureConversation } from "@/lib/automation/start-conversation";
import type { EventRow } from "@/lib/event-log/dispatcher";
import "@/lib/automation/actions/register-all";
import { runAutomationForEvent } from "@/lib/automation/engine";
import { GOV_ADMIN, GOV_ORG, seedGov, sql, lastLine } from "./gov-helpers";

/**
 * "NÃO ENVIAR" NÃO ENVIA QUANDO OUTRA REGRA DO MESMO GATILHO ESPERA A AGENDA.
 *
 * A escolha `quando_ha_compromisso` (#3813/#3818) vive no passo de envio. Com
 * duas regras no mesmo gatilho — uma `nao_enviar`, outra no padrão `adiar` —, a
 * pré-checagem do motor era tudo-ou-nada: o adiamento da segunda segurava o
 * EVENTO inteiro, e a `nao_enviar` só era avaliada na volta, quando o
 * compromisso já tinha passado (ou o operador o concluíra). A agenda respondia
 * "sem compromisso", a decisão virava `enviar`, e a regra que dizia "não envie"
 * enviava. Com UMA regra só ela pulava na hora (`compromisso_na_agenda`).
 *
 * O conserto (lib/automation/engine.ts): a pré-checagem adia só as regras que
 * pediram; as prontas rodam já; o evento volta se sobrar alguma adiada, e na
 * volta a regra que já tem run não-`adiado` deste evento não roda de novo.
 *
 *   A  — duas regras, reavaliação nos `retry_at` que o próprio motor devolve;
 *   A2 — duas regras, operador conclui o compromisso (`fn_appointment_change`);
 *   C  — controle: só a `nao_enviar`, pula na hora;
 *   D  — controle: só a `adiar`, espera e envia depois (o comportamento de sempre);
 *   E  — `enviar` ao lado de `adiar`: a pronta sai na hora e NÃO sai de novo na
 *        volta. O run dela pode ficar `adiado` (mensagem na fila, sem WhatsApp
 *        configurado) e mesmo assim é execução, não espera — é este cenário que
 *        segura o critério de "já rodou" do motor.
 *
 * Double de admin client copiado de `automation-send-whatsapp.test.ts` (o
 * Postgres efêmero não tem PostgREST), com `gt`/`gte` e jsonb de objetos. Cada
 * cenário usa o PRÓPRIO número: `espacarEnvio` guarda o último envio por sessão
 * em `Date.now()`, e o relógio falso de um cenário faria o seguinte dormir.
 */

function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v) && v.some((x) => x !== null && typeof x === "object")) return `${sqlString(JSON.stringify(v))}::jsonb`; // ponytail: jsonb[] de objetos (actions_result)
  if (Array.isArray(v)) return `ARRAY[${v.map((x) => sqlString(String(x))).join(",")}]::text[]`;
  if (typeof v === "object") return `${sqlString(JSON.stringify(v))}::jsonb`;
  return sqlString(String(v));
}

type QResult = { data: unknown; error: { message: string; code?: string } | null };
type RowResult = {
  data: Record<string, unknown> | null;
  error: { message: string; code?: string } | null;
};

type FilterOp = "eq" | "in" | "gt" | "gte";
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
 * `alias:fk_col(cols)`) / insert / update, eq/in/gt, order/limit, maybeSingle/single.
 *
 * `gt` entrou com a fatia #3286: a leitura de compromissos
 * (`protecaoAgendaSupabase`) pagina por KEYSET (`.order("id").limit(500)` +
 * `.gt("id", after)`) para não confiar no `max_rows` do PostgREST, e o dublê
 * não conhecia o método — a página não-vazia chamava `query.gt` inexistente, o
 * `catch` da produção devolvia `leitura_indisponivel` e a ação terminava
 * `failed` por um motivo que não era o do teste. Só apareceu quando um caso
 * passou a rodar a ação com compromisso SEMEADO no banco (nenhum caso anterior
 * chegava à segunda página).
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

  gt(col: string, val: unknown): this {
    this.filters.push({ op: "gt", col, val });
    return this;
  }

  gte(col: string, val: unknown): this {
    this.filters.push({ op: "gte", col, val });
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
    if (rows.length !== 1)
      return { data: null, error: { message: `expected 1 row, got ${rows.length}` } };
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
      if (f.op === "gt") return `${prefix}${f.col} > ${sqlLiteral(f.val)}`;
      if (f.op === "gte") return `${prefix}${f.col} >= ${sqlLiteral(f.val)}`;
      return `${prefix}${f.col} = ${sqlLiteral(f.val)}`;
    });
    return ` where ${clauses.join(" and ")}`;
  }

  /** Split top-level da lista de colunas (respeitando parênteses) — distingue coluna
   *  plana de embed PostgREST-style `alias:fk_col(col1, col2, ...)`. */
  private parseCols(): {
    plain: string[];
    embeds: Array<{ alias: string; fk: string; cols: string[] }>;
  } {
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
        if (name === "fn_service_begin") {
          try {
            const out = sql(
              `select public.fn_service_begin(p_org => ${sqlLiteral(params.p_org)}::uuid, p_contact => ${sqlLiteral(params.p_contact)}::uuid, p_session => ${sqlLiteral(params.p_session)}::uuid);`,
            );
            return { data: JSON.parse(out), error: null };
          } catch (error) {
            return { data: null, error: { message: String(error) } };
          }
        }
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

vi.mocked(createAdminClient).mockReturnValue(admin);

function rows(query: string): Array<Record<string, unknown>> {
  const out = sql(`select coalesce(json_agg(t), '[]') from (${query}) t;`);
  return JSON.parse(out || "[]");
}

const T0 = "2026-07-17T13:00:00Z"; // 10h em São Paulo, janela aberta; compromisso às 12h–13h locais
/** Os instantes de volta que o próprio motor devolve em `retry_at` (medidos na main 0781f19b5). */
const VOLTAS = ["2026-07-17T15:00:00Z", "2026-07-17T16:00:00Z", "2026-07-17T16:01:00Z", "2026-07-18T16:00:00Z"];

beforeAll(() => {
  seedGov();
});

afterEach(() => {
  vi.useRealTimers();
});

function evento(id: string): EventRow {
  // `created_at` vai junto: o `drain.ts` o seleciona, e é ele que limita a busca de runs do evento.
  return rows(
    `select id, organization_id, event_type, entity_kind, entity_id, payload, metadata, consumed_by, attempts, status, created_at
       from public.event_log where id = '${id}'`,
  )[0] as unknown as EventRow;
}

function emitirTag(contato: string): string {
  return lastLine(
    sql(`select public.emit_event('contact.tag_added','contact','${contato}',
      jsonb_build_object('service_origin',jsonb_build_object('kind','command','observed',public.fn_service_observe_command('${GOV_ORG}','${contato}'))),'{}','${GOV_ORG}');`),
  );
}

/** Contato com compromisso confirmado das 15h às 16h UTC, num número só dele. */
function semearCena(n: string, telefone: string): { contato: string; sessao: string; compromisso: string } {
  const contato = `55555555-aaaa-4000-8000-0000000000${n}`;
  const sessao = `55555555-2222-4000-8000-0000000000${n}`;
  const compromisso = `55555555-aaaa-4000-8000-0000000003${n}`;
  sql(`
    update public.automation_rules set is_active = false where organization_id = '${GOV_ORG}';
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status, daily_message_limit)
      values ('${sessao}', '${GOV_ORG}', 'inv-nao-enviar-${n}', '\\x00'::bytea, 'WORKING', 300)
      on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name, name, phone_number, is_blocked)
      values ('${contato}', '${GOV_ORG}', 'Contato nao-enviar ${n}', 'Bia', '${telefone}', false)
      on conflict do nothing;
    insert into public.calendar_appointments (id, organization_id, contact_id, title, starts_at, ends_at, status)
      values ('${compromisso}', '${GOV_ORG}', '${contato}', 'Consulta',
              '2026-07-17T15:00:00Z', '2026-07-17T16:00:00Z', 'confirmed')
      on conflict (id) do nothing;
  `);
  return { contato, sessao, compromisso };
}

function regra(id: string, nome: string, sessao: string, escolha: string | null): void {
  const cfg: Record<string, unknown> = { channel_session_id: sessao, template: `${nome} {{contact.name}}` };
  if (escolha) cfg.quando_ha_compromisso = escolha;
  sql(`insert into public.automation_rules (id, organization_id, name, trigger_event, conditions, actions, is_active)
    values ('${id}', '${GOV_ORG}', '${nome}', 'contact.tag_added', '[]'::jsonb,
      ${sqlString(JSON.stringify([{ type: "send_whatsapp_message", config: cfg }]))}::jsonb, true);`);
}

function mensagens(contato: string): string[] {
  return rows(
    `select body from public.messages where contact_id = '${contato}' and direction = 'outbound' order by created_at`,
  ).map((r) => String(r.body));
}

type Run = { status: string; actions_result: Array<{ status: string; detail?: Record<string, unknown> }> };
function runs(regraId: string, eventoId: string): Run[] {
  return rows(
    `select status, actions_result from public.automation_rule_runs
      where rule_id = '${regraId}' and event_id = '${eventoId}' order by created_at`,
  ) as never;
}
/**
 * Os runs de EXECUÇÃO — tudo menos a linha de espera que o motor grava ao adiar
 * (`registrarAdiamento`). Não é `status !== 'adiado'`: uma execução cuja
 * mensagem ficou na fila (sem WhatsApp configurado) também fecha `adiado`.
 */
const execucoes = (r: Run[]) => r.filter((x) => x.actions_result[0]?.detail?.reason !== "fora_da_janela_de_envio");

async function voltarNasHoras(ev: string): Promise<string> {
  let ultimo = "";
  for (const quando of VOLTAS) {
    vi.setSystemTime(new Date(quando));
    ultimo = (await runAutomationForEvent(admin, evento(ev))).status;
  }
  return ultimo;
}

/** A `nao_enviar` pulou UMA vez, na primeira passagem, com o motivo da agenda — e nunca mais rodou. */
function esperarPuloUnico(regraId: string, ev: string): void {
  const r = execucoes(runs(regraId, ev));
  expect(r, "a regra nao_enviar tem de ter exatamente um run, o do pulo").toHaveLength(1);
  expect(r[0]!.actions_result[0]?.status).toBe("skipped");
  expect(r[0]!.actions_result[0]?.detail?.reason).toBe("compromisso_na_agenda");
}

describe("nao_enviar não envia quando outra regra do mesmo gatilho adia pela agenda", () => {
  it("A. duas regras (nao_enviar + adiar): o compromisso passa e a nao_enviar segue sem enviar; a adiar envia uma vez", async () => {
    vi.setSystemTime(new Date(T0));
    const { contato, sessao } = semearCena("a1", "+5511977770001");
    const RN = "55555555-1111-4000-8000-0000000001a1";
    const RA = "55555555-1111-4000-8000-0000000002a1";
    await ensureConversation(admin, GOV_ORG, contato, sessao);
    regra(RN, "NAO_ENVIAR", sessao, "nao_enviar");
    regra(RA, "ADIAR", sessao, null);
    const ev = emitirTag(contato);

    const r1 = await runAutomationForEvent(admin, evento(ev));
    expect(r1.status, "a regra adiar ainda segura o evento").toBe("retry");

    expect(await voltarNasHoras(ev)).toBe("ok");
    expect(mensagens(contato).filter((b) => b.startsWith("NAO_ENVIAR")), "a regra nao_enviar ENVIOU").toEqual([]);
    expect(mensagens(contato).filter((b) => b.startsWith("ADIAR")), "a regra adiar envia, e uma vez só").toEqual(["ADIAR Bia"]);
    esperarPuloUnico(RN, ev);
    expect(execucoes(runs(RA, ev))).toHaveLength(1);
  });

  it("A2. duas regras: o operador conclui o compromisso; na volta a nao_enviar não envia", async () => {
    vi.setSystemTime(new Date(T0));
    const { contato, sessao, compromisso } = semearCena("a2", "+5511977770002");
    const RN = "55555555-1111-4000-8000-0000000001a2";
    const RA = "55555555-1111-4000-8000-0000000002a2";
    await ensureConversation(admin, GOV_ORG, contato, sessao);
    regra(RN, "NAO_ENVIAR", sessao, "nao_enviar");
    regra(RA, "ADIAR", sessao, null);
    const ev = emitirTag(contato);

    const r1 = await runAutomationForEvent(admin, evento(ev));
    expect(r1.status).toBe("retry");
    // O caminho de produção da tela: fn_appointment_change como membro humano (auth.uid()).
    sql(`begin;
      select set_config('request.jwt.claims', '{"sub":"${GOV_ADMIN}","role":"authenticated"}', true);
      select public.fn_appointment_change('${GOV_ORG}', '${compromisso}', (select revision from public.calendar_appointments where id = '${compromisso}'), '{"status":"completed"}'::jsonb);
      commit;`);
    expect(rows(`select status from public.calendar_appointments where id = '${compromisso}'`)[0]?.status).toBe("completed");

    vi.setSystemTime(new Date("2026-07-17T16:30:00Z"));
    expect((await runAutomationForEvent(admin, evento(ev))).status).toBe("ok");
    expect(mensagens(contato).filter((b) => b.startsWith("NAO_ENVIAR")), "a regra nao_enviar ENVIOU").toEqual([]);
    expect(mensagens(contato).filter((b) => b.startsWith("ADIAR"))).toEqual(["ADIAR Bia"]);
    esperarPuloUnico(RN, ev);
  });

  it("C. controle: só a nao_enviar — pula na hora com compromisso_na_agenda", async () => {
    vi.setSystemTime(new Date(T0));
    const { contato, sessao } = semearCena("c1", "+5511977770003");
    const RN = "55555555-1111-4000-8000-0000000001c1";
    await ensureConversation(admin, GOV_ORG, contato, sessao);
    regra(RN, "NAO_ENVIAR", sessao, "nao_enviar");
    const ev = emitirTag(contato);

    expect((await runAutomationForEvent(admin, evento(ev))).status).toBe("ok");
    expect(mensagens(contato)).toEqual([]);
    esperarPuloUnico(RN, ev);
  });

  it("D. controle: só a adiar (padrão) — espera o compromisso e envia depois, uma vez", async () => {
    vi.setSystemTime(new Date(T0));
    const { contato, sessao } = semearCena("d1", "+5511977770004");
    const RA = "55555555-1111-4000-8000-0000000002d1";
    await ensureConversation(admin, GOV_ORG, contato, sessao);
    regra(RA, "ADIAR", sessao, null);
    const ev = emitirTag(contato);

    const r1 = await runAutomationForEvent(admin, evento(ev));
    expect(r1.status).toBe("retry");
    expect(r1.retry_at).toBe(new Date(VOLTAS[0]!).toISOString());
    expect(mensagens(contato), "nada sai enquanto o compromisso protege").toEqual([]);

    expect(await voltarNasHoras(ev)).toBe("ok");
    expect(mensagens(contato)).toEqual(["ADIAR Bia"]);
    expect(execucoes(runs(RA, ev))).toHaveLength(1);
  });

  it("E. enviar + adiar: a enviar sai na hora e não sai de novo quando o evento volta", async () => {
    vi.setSystemTime(new Date(T0));
    const { contato, sessao } = semearCena("e1", "+5511977770005");
    const RE = "55555555-1111-4000-8000-0000000001e1";
    const RA = "55555555-1111-4000-8000-0000000002e1";
    await ensureConversation(admin, GOV_ORG, contato, sessao);
    regra(RE, "ENVIAR", sessao, "enviar");
    regra(RA, "ADIAR", sessao, null);
    const ev = emitirTag(contato);

    expect((await runAutomationForEvent(admin, evento(ev))).status).toBe("retry");
    expect(await voltarNasHoras(ev)).toBe("ok");
    expect(mensagens(contato).filter((b) => b.startsWith("ENVIAR")), "a regra enviar saiu em dobro").toEqual(["ENVIAR Bia"]);
    expect(mensagens(contato).filter((b) => b.startsWith("ADIAR"))).toEqual(["ADIAR Bia"]);
    expect(runs(RE, ev), "um run só da regra enviar, o da execução").toHaveLength(1);
    expect(execucoes(runs(RA, ev))).toHaveLength(1);
  });
});
