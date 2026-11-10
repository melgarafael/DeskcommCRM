import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { AUTOMATION_CONSUMER_KEY, runAutomationForEvent } from "@/lib/automation/engine";
import { registerAction } from "@/lib/automation/actions";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { GOV_CONTACT_2, GOV_CONTACT_3, GOV_LEAD, GOV_ORG, GOV_PIPELINE, GOV_STAGE, seedGov, sql, lastLine } from "./gov-helpers";

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
  /**
   * A chave única do `insert`/`upsert` (#2974).
   *
   * O motor reserva a chave `(regra, contato)` com
   * `.upsert(…, { onConflict, ignoreDuplicates: true })`, que no fio é
   * `insert … on conflict (<colunas>) do nothing` + `resolution=ignore-duplicates`.
   * Sem traduzir as opções aqui, o harness mandaria um `insert` CRU: a chave
   * repetida viraria violação de unicidade (erro) em vez de lista vazia, e o
   * caminho que o motor mede com `data === null` nunca seria exercido.
   */
  private insertOpts: { onConflict?: string; ignoreDuplicates?: boolean } | null = null;
  private filters: Array<{ col: string; val: unknown }> = [];
  private orderCol?: string;
  private orderAsc = true;
  private limitN?: number;

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

  insert(data: Record<string, unknown>, opts?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.mode = "insert";
    this.mutationData = data;
    this.insertOpts = opts ?? null;
    return this;
  }

  /**
   * `upsert(…, { ignoreDuplicates: true })` é o mesmo `on conflict do nothing` do
   * insert — aqui os dois caem no mesmo caminho de propósito, porque é o mesmo
   * SQL que o PostgREST monta.
   */
  upsert(data: Record<string, unknown>, opts?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.mode = "insert";
    this.mutationData = data;
    this.insertOpts = { ignoreDuplicates: true, ...opts };
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

  /**
   * `limit` entrou com o #2974: a conferência "esta regra já rodou para este
   * contato?" usa `.limit(1)` com LISTA (nunca `maybeSingle()`, que erra quando
   * há mais de uma linha). Sem traduzir o `limit` aqui, o harness devolveria
   * todas as linhas e o caso mediria outra coisa.
   */
  limit(n: number): this {
    if (this.mode !== "select") throw new Error("limit() só é usado em select neste harness");
    this.limitN = n;
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
      if (this.limitN !== undefined) q += ` limit ${this.limitN}`;
      return q;
    }
    if (this.mode === "insert") {
      const cols = Object.keys(this.mutationData!);
      const vals = cols.map((c) => sqlLiteral(this.mutationData![c]));
      const corpo = `insert into public.${this.table} (${cols.join(", ")}) values (${vals.join(", ")})`;
      // `on conflict (…) do nothing` é o que o motor manda para RESERVAR a chave
      // (regra, contato); sem ele o insert cru estoura unicidade na repetição.
      const opts = this.insertOpts;
      return opts?.ignoreDuplicates && opts.onConflict
        ? `${corpo} on conflict (${opts.onConflict}) do nothing`
        : corpo;
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

function runsForRule(
  ruleId: string,
): Array<{ status: string; contact_id: string | null; actions_result: Array<{ type: string; status: string; error?: string }> }> {
  const out = sql(
    `select coalesce(json_agg(t), '[]') from (select status, contact_id, actions_result from public.automation_rule_runs where rule_id = ${sqlString(ruleId)} order by created_at) t;`,
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
/** #2974 — a regra "no máximo uma vez por contato". */
const R7 = "dddddddd-1111-4000-8000-000000000007";
const TITULO_DO_LIMITE = "Lead do limite por contato";
const LEAD_LIMITE_A = "dddddddd-6666-4000-8000-000000000001";
const LEAD_LIMITE_B = "dddddddd-6666-4000-8000-000000000002";

let fakeOkCalls = 0;
/** Contador PRÓPRIO do #2974: isola a execução de R7 das demais regras do arquivo. */
let limiteCalls = 0;
registerAction({
  type: "fake_ok_uma_vez",
  async execute() {
    limiteCalls += 1;
    return { type: "fake_ok_uma_vez", status: "success" };
  },
});
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
    -- #2974 — R7 roda no MÁXIMO uma vez por contato. A condição de título a
    -- isola dos outros casos (o lead criado aqui carrega contato; os demais não).
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id)
      values
        ('${LEAD_LIMITE_A}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', '${TITULO_DO_LIMITE}', '${GOV_CONTACT_2}'),
        ('${LEAD_LIMITE_B}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', '${TITULO_DO_LIMITE}', '${GOV_CONTACT_3}')
      on conflict do nothing;
    insert into public.automation_rules (id, organization_id, name, trigger_event, conditions, actions, is_active, trigger_config)
      values ('${R7}', '${GOV_ORG}', 'R7 (uma vez por contato)', 'lead.created',
        '[{"field":"lead.title","op":"eq","value":"${TITULO_DO_LIMITE}"}]'::jsonb,
        '[{"type":"fake_ok_uma_vez"}]'::jsonb, true,
        '{"uma_vez_por_contato":true}'::jsonb)
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

  it("postpone: adia o evento inteiro ANTES de qualquer ação (all-or-nothing), e a espera VIRA um run 'adiado'", async () => {
    // ═══ Por que este caso mudou, e por que ele passava por ACIDENTE ═══
    //
    // Ele afirmava `runsCount()` inalterado — "zero runs" — e usava um id de
    // evento SINTÉTICO (`00000000-…-0003`) que nunca existiu em `event_log`.
    // Enquanto adiar não gravava nada, as duas coisas conviviam sem se tocar.
    //
    // Desde que o adiamento passou a ser um ESTADO (migration 0175), o motor
    // grava um run `adiado` — e a FK `automation_rule_runs_event_id_fkey` exigia
    // um evento que a fixture não tinha. O INSERT falhava, o log gritava
    // ("não foi possível registrar o adiamento", visível no job `invariants`),
    // e o caso continuava VERDE lendo zero runs. Verde pelo motivo errado: ele
    // media a FK quebrada, não o comportamento.
    //
    // Agora o evento é REAL, e a asserção é a que importa — porque "não
    // apareceu nada na Atividade" e "a automação não rodou" serem a mesma tela
    // foi o defeito que originou esta entrega inteira.
    const okBefore = fakeOkCalls;
    const antes = runsForRule(R5).length;
    const eventId = emitRealEvent("lead.stage_changed", "crm_lead", GOV_LEAD);
    const row = baseRow({
      id: eventId,
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

    // ALL-OR-NOTHING continua valendo: a 2ª ação de R5 não foi executada.
    expect(fakeOkCalls).toBe(okBefore);

    // E a espera é VISÍVEL: exatamente um run novo, com o estado que a 0175 abriu.
    const runs = runsForRule(R5);
    expect(runs.length).toBe(antes + 1);
    expect(runs[runs.length - 1]!.status).toBe("adiado");
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

  // ═══════════════════════════════════════════════════════════════════════════
  // #2974 — "NO MÁXIMO UMA VEZ POR CONTATO", medido contra o banco de verdade.
  //
  // O teste de unidade (lib/automation/limite-por-contato-no-motor.test.ts) usa
  // um dublê. Aqui a decisão passa pelo Postgres: a coluna `contact_id` existe
  // (é a migration 0731), a FK para `contacts` vale, e a segunda passagem do
  // contato encontra a LINHA que a primeira gravou — o estado persistido, não
  // memória de processo.
  // ═══════════════════════════════════════════════════════════════════════════
  it("⭐ o mesmo contato roda R7 uma vez; a segunda passagem fica registrada com a razão e não executa", async () => {
    const okAntes = limiteCalls;
    const eventA = emitRealEvent("lead.created", "crm_lead", LEAD_LIMITE_A);
    const primeira = await runAutomationForEvent(
      fakeAdminClient(),
      baseRow({ id: eventA, event_type: "lead.created", entity_kind: "crm_lead", entity_id: LEAD_LIMITE_A }),
    );
    expect(primeira.status).toBe("ok");
    expect(limiteCalls, "a primeira mensagem do contato não executou R7").toBe(okAntes + 1);

    const depoisDaPrimeira = runsForRule(R7);
    expect(depoisDaPrimeira.length).toBe(1);
    expect(depoisDaPrimeira[0]!.contact_id).toBe(GOV_CONTACT_2);
    expect(depoisDaPrimeira[0]!.status).toBe("success");

    const eventB = emitRealEvent("lead.created", "crm_lead", LEAD_LIMITE_A);
    const segunda = await runAutomationForEvent(
      fakeAdminClient(),
      baseRow({ id: eventB, event_type: "lead.created", entity_kind: "crm_lead", entity_id: LEAD_LIMITE_A }),
    );

    // O evento não vira "nada aconteceu": a decisão fica na tabela (a asserção
    // abaixo), e é ela que a aba Atividade mostra. O `detail: uma_vez_por_contato`
    // do retorno só aparece quando NENHUMA regra roda no evento — aqui o R1 (que
    // casa todo lead.created) roda junto, então o retorno é o `ok` de sempre.
    // Quem mede o `detail` é o teste de unidade do motor.
    expect(segunda.status).toBe("ok");
    expect(limiteCalls, "a segunda mensagem do mesmo contato executou a ação").toBe(okAntes + 1);

    const runs = runsForRule(R7);
    expect(runs.length).toBe(2);
    const bloqueio = runs[1]!;
    expect(bloqueio.contact_id).toBe(GOV_CONTACT_2);
    expect(bloqueio.status).toBe("failed");
    expect(bloqueio.actions_result).toEqual([
      { type: "fake_ok_uma_vez", status: "skipped", error: "uma_vez_por_contato" },
    ]);
  });

  it("⭐ um contato DIFERENTE continua rodando — o limite é por contato, não pela regra", async () => {
    const okAntes = limiteCalls;
    const eventId = emitRealEvent("lead.created", "crm_lead", LEAD_LIMITE_B);
    const result = await runAutomationForEvent(
      fakeAdminClient(),
      baseRow({ id: eventId, event_type: "lead.created", entity_kind: "crm_lead", entity_id: LEAD_LIMITE_B }),
    );

    expect(result.status).toBe("ok");
    expect(limiteCalls, "o contato B não executou R7").toBe(okAntes + 1);

    const runs = runsForRule(R7);
    const ultima = runs[runs.length - 1]!;
    expect(ultima.contact_id).toBe(GOV_CONTACT_3);
    expect(ultima.status).toBe("success");
  });

  /**
   * ⭐ O ÁRBITRO DA CORRIDA, medido no BANCO e não no motor.
   *
   * Duas chamadas do motor NÃO conseguem correr de verdade neste harness: o
   * `sql()` é `execFileSync`, então cada consulta bloqueia o laço de eventos e as
   * duas passariam uma DEPOIS da outra — um caso verde que não mede corrida
   * nenhuma. O que se mede aqui é a peça que faz a corrida ter um vencedor: a
   * chave única e o `on conflict … do nothing` com que o motor a toma. É o
   * SQL exato que o PostgREST monta para
   * `.upsert(…, { onConflict, ignoreDuplicates: true })`.
   *
   * Sem o índice único este caso fica VERMELHO na segunda reserva (duas linhas, e
   * o motor executaria duas vezes): é por isso que ele é invariante, e não
   * comentário.
   */
  it("⭐ a reserva da chave (regra, contato) é única no banco: a segunda tentativa não grava", () => {
    // R1 não tem a opção ligada, então o motor NUNCA reserva por ela: usar R1 aqui
    // deixa o caso sem ordem — nenhum outro teste deste arquivo disputa esta chave.
    const reservar = () =>
      Number(
        lastLine(
          sql(`
            with w as (
              insert into public.automation_rule_contact_claims (organization_id, rule_id, contact_id)
              values (${sqlString(GOV_ORG)}, ${sqlString(R1)}, ${sqlString(GOV_CONTACT_2)})
              on conflict (organization_id, rule_id, contact_id) do nothing
              returning id
            ) select count(*) from w;
          `),
        ),
      );

    expect(reservar(), "a primeira reserva não gravou a chave").toBe(1);
    expect(reservar(), "a segunda reserva da MESMA chave gravou — não há árbitro").toBe(0);
    expect(
      Number(
        lastLine(
          sql(
            `select count(*) from public.automation_rule_contact_claims where rule_id = ${sqlString(R1)};`,
          ),
        ),
      ),
      "a chave existe mais de uma vez para a mesma (regra, contato)",
    ).toBe(1);
  });
});
