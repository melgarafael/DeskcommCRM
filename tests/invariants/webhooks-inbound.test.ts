import { createHmac } from "node:crypto";

import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { POST } from "@/app/api/v1/webhooks/in/[token]/route";
import { GOV_ORG, GOV_PIPELINE, GOV_STAGE, seedGov, sql } from "./gov-helpers";

/**
 * Task 6 (spec webhooks/automação 2026-07-17) — rota inbound pública
 * POST /api/v1/webhooks/in/[token].
 *
 * Mesma limitação de infra documentada em webhooks-rls.test.ts /
 * event-log-drain.test.ts / webhooks-trigger-events.test.ts: o harness sobe só
 * um Postgres cru (sem PostgREST/HTTP). `@/lib/supabase/admin` é mockado para
 * este arquivo inteiro — `createAdminClient()` (chamado pela rota, por
 * createLeadHandler E por audit(), já que isServiceRoleConfigured() é true no
 * env de teste) devolve o double abaixo, que traduz .from().select()/
 * .insert()/.update() + filtros/.order()/.limit()/.maybeSingle()/.single() e
 * .rpc('emit_event', ...) pra SQL via `sql()` (docker exec psql) — extensão do
 * double de event-log-drain.test.ts / webhooks-trigger-events.test.ts com
 * suporte a INSERT (a rota grava webhook_events_log/contacts/crm_leads e
 * audit() grava api_audit_log).
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

/**
 * Double mínimo de um PostgrestQueryBuilder — só os métodos que a rota +
 * createLeadHandler + audit() efetivamente usam: select/insert/update, filtro
 * eq, order/limit, maybeSingle/single, e await direto (sem select final).
 */
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

vi.mocked(createAdminClient).mockReturnValue(fakeAdminClient());

function rows(query: string): Array<Record<string, unknown>> {
  const out = sql(`select coalesce(json_agg(t), '[]') from (${query}) t;`);
  return JSON.parse(out || "[]");
}

function reqCtx(token: string) {
  return { params: Promise.resolve({ token }) };
}

function jsonReq(token: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/v1/webhooks/in/${token}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

function formReq(token: string, rawBody: string) {
  return new NextRequest(`http://localhost/api/v1/webhooks/in/${token}`, {
    method: "POST",
    body: rawBody,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

// Namespace próprio (dddddddd-) — reusa GOV_ORG/GOV_PIPELINE/GOV_STAGE (já
// seedados por seedGov()).
const WHIN_SOURCE_JSON = "dddddddd-5555-4000-8000-000000000001";
const WHIN_SOURCE_FORM = "dddddddd-5555-4000-8000-000000000002";
const WHIN_SOURCE_INACTIVE = "dddddddd-5555-4000-8000-000000000003";
const WHIN_SOURCE_SECRET = "dddddddd-5555-4000-8000-000000000004";
const SECRET = "test-webhook-secret-abc123";
const REDIRECT_TO = "https://example.com/obrigado";

const TOKEN_JSON = "wh-in-json-token-1234";
const TOKEN_FORM = "wh-in-form-token-1234";
const TOKEN_INACTIVE = "wh-in-inactive-token-1234";
const TOKEN_SECRET = "wh-in-secret-token-1234";
const TOKEN_UNKNOWN = "wh-in-does-not-exist-1234";

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.webhook_sources
      (id, organization_id, name, path_token, default_pipeline_id, default_stage_id)
      values ('${WHIN_SOURCE_JSON}', '${GOV_ORG}', 'JSON source', '${TOKEN_JSON}', '${GOV_PIPELINE}', '${GOV_STAGE}')
      on conflict do nothing;
    insert into public.webhook_sources
      (id, organization_id, name, path_token, default_pipeline_id, default_stage_id, redirect_to)
      values ('${WHIN_SOURCE_FORM}', '${GOV_ORG}', 'Form source', '${TOKEN_FORM}', '${GOV_PIPELINE}', '${GOV_STAGE}', '${REDIRECT_TO}')
      on conflict do nothing;
    insert into public.webhook_sources
      (id, organization_id, name, path_token, default_pipeline_id, default_stage_id, is_active)
      values ('${WHIN_SOURCE_INACTIVE}', '${GOV_ORG}', 'Inactive source', '${TOKEN_INACTIVE}', '${GOV_PIPELINE}', '${GOV_STAGE}', false)
      on conflict do nothing;
    insert into public.webhook_sources
      (id, organization_id, name, path_token, default_pipeline_id, default_stage_id, secret)
      values ('${WHIN_SOURCE_SECRET}', '${GOV_ORG}', 'Secret source', '${TOKEN_SECRET}', '${GOV_PIPELINE}', '${GOV_STAGE}', '${SECRET}')
      on conflict do nothing;
  `);
});

describe("POST /api/v1/webhooks/in/[token] (Task 6)", () => {
  it("caso 1 — JSON feliz: cria contato + lead, loga evento, atualiza last_received_at", async () => {
    const body = { nome: "Ana", telefone: "11998765432", utm_source: "ig", empresa: "ACME" };
    const res = await POST(jsonReq(TOKEN_JSON, body), reqCtx(TOKEN_JSON));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { lead_id: string } };
    const leadId = json.data.lead_id;
    expect(leadId).toBeTruthy();

    const leadRows = rows(`select * from public.crm_leads where id = '${leadId}'`);
    expect(leadRows.length).toBe(1);
    const lead = leadRows[0]!;
    expect(lead.title).toBe("Ana");
    expect(lead.source).toBe("webhook");
    expect((lead.custom_fields as Record<string, unknown>).empresa).toBe("ACME");
    expect((lead.source_metadata as Record<string, unknown>).utm_source).toBe("ig");
    expect(lead.organization_id).toBe(GOV_ORG);

    const contactRows = rows(`select * from public.contacts where id = '${lead.contact_id}'`);
    expect(contactRows.length).toBe(1);
    expect(contactRows[0]!.phone_number).toBe("+5511998765432");

    // entity_kind='crm_lead' é a emissão explícita de createLeadHandler (mesma
    // convenção de moveLeadHandler/updateLeadHandler). O trigger de banco
    // fn_emit_event_on_lead_change TAMBÉM emite lead.created no INSERT (com
    // entity_kind='lead') — duplicação pré-existente fora do escopo desta
    // task; filtramos por entity_kind pra não confundir os dois emissores.
    const eventRows = rows(
      `select * from public.event_log where event_type = 'lead.created' and entity_kind = 'crm_lead' and entity_id = '${leadId}'`,
    );
    expect(eventRows.length).toBe(1);

    const logRows = rows(
      `select * from public.webhook_events_log where webhook_path_token = '${TOKEN_JSON}' order by received_at desc limit 1`,
    );
    expect(logRows.length).toBe(1);
    expect(logRows[0]!.provider).toBe("generic");

    const sourceRows = rows(`select last_received_at from public.webhook_sources where id = '${WHIN_SOURCE_JSON}'`);
    expect(sourceRows[0]!.last_received_at).not.toBeNull();
  });

  it("caso 2 — form-post: 303 + Location = redirect_to, lead criado", async () => {
    const res = await POST(formReq(TOKEN_FORM, "nome=Bia&telefone=11912345678"), reqCtx(TOKEN_FORM));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(REDIRECT_TO);

    const leadRows = rows(
      `select * from public.crm_leads where organization_id = '${GOV_ORG}' and title = 'Bia'`,
    );
    expect(leadRows.length).toBe(1);
  });

  it("caso 3 — token inexistente e fonte inativa devolvem 404 idêntico", async () => {
    const resUnknown = await POST(jsonReq(TOKEN_UNKNOWN, { nome: "X" }), reqCtx(TOKEN_UNKNOWN));
    expect(resUnknown.status).toBe(404);
    const bodyUnknown = (await resUnknown.json()) as { error: { code: string } };

    const resInactive = await POST(jsonReq(TOKEN_INACTIVE, { nome: "X" }), reqCtx(TOKEN_INACTIVE));
    expect(resInactive.status).toBe(404);
    const bodyInactive = (await resInactive.json()) as { error: { code: string } };

    expect(bodyUnknown.error.code).toBe(bodyInactive.error.code);
    expect(bodyUnknown.error.code).toBe("not_found");
  });

  it("caso 4 — fonte com secret: sem assinatura 401 + nenhum lead; com assinatura correta 200", async () => {
    const rawBody = JSON.stringify({ nome: "Carla", telefone: "11955554444" });

    const reqNoSig = new NextRequest(`http://localhost/api/v1/webhooks/in/${TOKEN_SECRET}`, {
      method: "POST",
      body: rawBody,
      headers: { "content-type": "application/json" },
    });
    const resNoSig = await POST(reqNoSig, reqCtx(TOKEN_SECRET));
    expect(resNoSig.status).toBe(401);
    expect(rows(`select * from public.crm_leads where title = 'Carla'`).length).toBe(0);

    const validSig = createHmac("sha256", SECRET).update(rawBody).digest("hex");
    const reqWithSig = new NextRequest(`http://localhost/api/v1/webhooks/in/${TOKEN_SECRET}`, {
      method: "POST",
      body: rawBody,
      headers: { "content-type": "application/json", "x-deskcomm-signature": validSig },
    });
    const resWithSig = await POST(reqWithSig, reqCtx(TOKEN_SECRET));
    expect(resWithSig.status).toBe(200);
    expect(rows(`select * from public.crm_leads where title = 'Carla'`).length).toBe(1);
  });

  it("caso 5 — payload sem nome/telefone/email: 400 invalid_request, sem lead", async () => {
    const before = rows(`select count(*) as n from public.crm_leads where organization_id = '${GOV_ORG}'`)[0]!.n;
    const res = await POST(jsonReq(TOKEN_JSON, { utm_source: "ig", empresa: "ACME" }), reqCtx(TOKEN_JSON));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
    const after = rows(`select count(*) as n from public.crm_leads where organization_id = '${GOV_ORG}'`)[0]!.n;
    expect(after).toBe(before);
  });

  it("caso 6 — isolamento: organization_id do lead vem da FONTE, nunca do body", async () => {
    const spoof = { nome: "Isolamento", telefone: "11999998888", organization_id: "11111111-1111-4111-8111-111111111111" };
    const res = await POST(jsonReq(TOKEN_JSON, spoof), reqCtx(TOKEN_JSON));
    expect(res.status).toBe(200);
    const leadRows = rows(`select * from public.crm_leads where title = 'Isolamento'`);
    expect(leadRows.length).toBe(1);
    expect(leadRows[0]!.organization_id).toBe(GOV_ORG);
    // O valor "organization_id" do body vira custom_fields (não é aplicado).
    expect((leadRows[0]!.custom_fields as Record<string, unknown>).organization_id).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("bônus — telefone que falha normalizePhoneBR vai pra source_metadata.raw_phone (observabilidade)", async () => {
    const res = await POST(jsonReq(TOKEN_JSON, { nome: "Carlos", telefone: "abc-invalid" }), reqCtx(TOKEN_JSON));
    expect(res.status).toBe(200);
    const leadRows = rows(`select * from public.crm_leads where title = 'Carlos'`);
    expect(leadRows.length).toBe(1);
    expect((leadRows[0]!.source_metadata as Record<string, unknown>).raw_phone).toBe("abc-invalid");
    expect(leadRows[0]!.contact_id).toBeNull();
  });

  it("caso 7 — telefone já tem contato ativo: reusa o contato existente, não duplica", async () => {
    const preexistingId = "dddddddd-6666-4000-8000-000000000001";
    const phone = "+5511977776666";
    sql(`
      insert into public.contacts (id, organization_id, name, phone_number, source)
      values ('${preexistingId}', '${GOV_ORG}', 'Duda Preexistente', '${phone}', 'manual')
      on conflict do nothing;
    `);

    const res = await POST(jsonReq(TOKEN_JSON, { nome: "Duda", telefone: "11977776666" }), reqCtx(TOKEN_JSON));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { lead_id: string } };

    const leadRows = rows(`select * from public.crm_leads where id = '${json.data.lead_id}'`);
    expect(leadRows.length).toBe(1);
    expect(leadRows[0]!.contact_id).toBe(preexistingId);

    const contactCount = Number(
      rows(
        `select count(*) as n from public.contacts where organization_id = '${GOV_ORG}' and phone_number = '${phone}'`,
      )[0]!.n,
    );
    expect(contactCount).toBe(1);

    // ponytail: uma corrida de verdade (dois POSTs concorrentes batendo no
    // 23505 do insert) não é reproduzível neste harness — não há duas
    // conexões/transações concorrentes disponíveis via docker-exec-psql
    // síncrono. Este caso cobre a mesma lógica de re-seleção
    // (selectActiveByPhone) que o branch do catch usa; o branch do catch em
    // si (insertErr.code === "23505") fica sem cobertura direta de teste.
  });

  // ponytail: rate limit cai no fallback in-memory sem Upstash (sem env
  // configurada no vitest.db.config.ts) — esse fallback já é coberto por
  // unit test em lib/ai/dispatcher/rate-limit.ts. Provar o 429 aqui exigiria
  // 61 chamadas sequenciais só pra exercitar um path já testado; pulado.
  it.skip("rate limit 429 após estourar a janela — coberto por unit test do fallback in-memory", () => {});
});
