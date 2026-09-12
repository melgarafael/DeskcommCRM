import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

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

type FilterOp = "eq" | "is" | "in";
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

  in(col: string, val: unknown[]): this {
    this.filters.push({ op: "in", col, val });
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
    const clauses = this.filters.map((f) => {
      if (f.op === "is") return `${f.col} is ${f.val === null ? "null" : sqlLiteral(f.val)}`;
      if (f.op === "in") {
        const list = Array.isArray(f.val) ? f.val : [];
        return `${f.col} in (${list.map((v) => sqlLiteral(v)).join(", ")})`;
      }
      return `${f.col} = ${sqlLiteral(f.val)}`;
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
        // migration 0039: a rota decifra o secret da fonte via RPC.
        if (name === "fn_decrypt_oauth") {
          try {
            const ct = String((params as { ciphertext: string }).ciphertext);
            const out = sql(
              `select public.fn_decrypt_oauth(${sqlString(ct)}::bytea);`,
            ).trim();
            return { data: out || null, error: null };
          } catch (err) {
            return { data: null, error: { message: (err as Error).message } };
          }
        }
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
const WHIN_SOURCE_RESPONDI = "dddddddd-5555-4000-8000-000000000005";
const WHIN_SOURCE_RDSTATION = "dddddddd-5555-4000-8000-000000000006";
// Fixture própria (namespace ffffffff, mesmo padrão de webhooks-rls.test.ts) —
// org B só pra provar que o fallback por e-mail não cruza tenant.
const WHIN_ORG_B = "ffffffff-0000-4000-8000-000000000101";
const WHIN_PIPELINE_B = "ffffffff-5555-4000-8000-000000000101";
const WHIN_STAGE_B = "ffffffff-5555-4000-8000-000000000102";
const WHIN_SOURCE_RESPONDI_B = "ffffffff-5555-4000-8000-000000000103";
const TOKEN_RESPONDI_B = "wh-in-respondi-org-b-token-1234";
const WHIN_SOURCE_RDSTATION_B = "ffffffff-5555-4000-8000-000000000104";
const TOKEN_RDSTATION_B = "wh-in-rdstation-org-b-token-1234";
const SECRET = "test-webhook-secret-abc123";
const REDIRECT_TO = "https://example.com/obrigado";

const TOKEN_JSON = "wh-in-json-token-1234";
const TOKEN_FORM = "wh-in-form-token-1234";
const TOKEN_INACTIVE = "wh-in-inactive-token-1234";
const TOKEN_SECRET = "wh-in-secret-token-1234";
const TOKEN_UNKNOWN = "wh-in-does-not-exist-1234";
const TOKEN_RESPONDI = "wh-in-respondi-token-1234";
const TOKEN_RDSTATION = "wh-in-rdstation-token-1234";

/** Fixture sanitizada — mesma FORMA do payload real do Respondi (webhook_events_log, 2026-08-25). */
const RESPONDI_FIXTURE = JSON.parse(
  readFileSync("tests/fixtures/webhooks/respondi-imobiliario.json", "utf8"),
) as Record<string, unknown>;

/**
 * Cópia funda com respondent_id, telefone e e-mail trocados.
 *
 * `respondent_id` — cada teste precisa do seu, senão o dedup por external_id
 * os confunde. `phone`/`email` — idem para o contato: `uniq_contacts_org_email`
 * (baseline.sql:2911) é tão real quanto `uniq_contacts_org_phone`, e a rota
 * reusa contato existente por telefone OU colide no INSERT por e-mail
 * repetido — dois testes que compartilham qualquer um dos dois acabam no
 * MESMO contato (ou, pior, um 23505 por e-mail que a rota só sabe
 * recuperar re-selecionando por TELEFONE — achado à parte, fora do escopo
 * deste fix). Cada `it()` usa telefone E e-mail próprios.
 */
function respondiPayload(
  respondentId: string,
  phone: string,
  email: string,
  overrides: (p: Record<string, unknown>) => void = () => {},
) {
  const clone = JSON.parse(JSON.stringify(RESPONDI_FIXTURE)) as Record<string, unknown>;
  const respondent = clone.respondent as Record<string, unknown>;
  respondent.respondent_id = respondentId;
  const answers = respondent.answers as Record<string, unknown>;
  answers["Qual é o melhor WhatsApp para falarmos sobre essa análise?"] = phone;
  answers["Qual é o seu melhor e-mail?"] = email;
  overrides(clone);
  return clone;
}

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
    -- migration 0039: secret é cifrado at-rest. Configura a GUC da chave no
    -- database efêmero (sessões novas herdam — o fake rpc de decrypt precisa)
    -- e cifra o fixture na MESMA sessão via set_config.
    do $guc$ begin
      execute format('alter database %I set app.nuvemshop_oauth_key = %L',
                     current_database(), 'test-guc-key-0123456789abcdef0123456789abcdef');
    end $guc$;
    select set_config('app.nuvemshop_oauth_key', 'test-guc-key-0123456789abcdef0123456789abcdef', false);
    insert into public.webhook_sources
      (id, organization_id, name, path_token, default_pipeline_id, default_stage_id, secret_encrypted)
      values ('${WHIN_SOURCE_SECRET}', '${GOV_ORG}', 'Secret source', '${TOKEN_SECRET}', '${GOV_PIPELINE}', '${GOV_STAGE}', public.fn_encrypt_oauth('${SECRET}'))
      on conflict do nothing;
    insert into public.webhook_sources
      (id, organization_id, name, path_token, default_pipeline_id, default_stage_id)
      values ('${WHIN_SOURCE_RESPONDI}', '${GOV_ORG}', 'Respondi — Decola Aí Imobiliário', '${TOKEN_RESPONDI}', '${GOV_PIPELINE}', '${GOV_STAGE}')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${WHIN_ORG_B}', 'gov-inv-whin-org-b', 'Gov Invariant Webhooks-In Org B', 'Gov Inv Whin B')
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${WHIN_PIPELINE_B}', '${WHIN_ORG_B}', 'Pipeline B', 'pipeline-b')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${WHIN_STAGE_B}', '${WHIN_ORG_B}', '${WHIN_PIPELINE_B}', 'Novo', 'novo', 1000)
      on conflict do nothing;
    insert into public.webhook_sources
      (id, organization_id, name, path_token, default_pipeline_id, default_stage_id)
      values ('${WHIN_SOURCE_RESPONDI_B}', '${WHIN_ORG_B}', 'Respondi Org B', '${TOKEN_RESPONDI_B}', '${WHIN_PIPELINE_B}', '${WHIN_STAGE_B}')
      on conflict do nothing;
    insert into public.webhook_sources
      (id, organization_id, name, path_token, default_pipeline_id, default_stage_id)
      values ('${WHIN_SOURCE_RDSTATION}', '${GOV_ORG}', 'RD Station JBA (fixture)', '${TOKEN_RDSTATION}', '${GOV_PIPELINE}', '${GOV_STAGE}')
      on conflict do nothing;
    insert into public.webhook_sources
      (id, organization_id, name, path_token, default_pipeline_id, default_stage_id)
      values ('${WHIN_SOURCE_RDSTATION_B}', '${WHIN_ORG_B}', 'RD Station Org B', '${TOKEN_RDSTATION_B}', '${WHIN_PIPELINE_B}', '${WHIN_STAGE_B}')
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

describe("POST /api/v1/webhooks/in/[token] — Respondi (payload aninhado, achado 2026-08-25)", () => {
  it("caso 1 — envio real do Respondi cria contato + lead com campos mapeados, título empresa+nome, consentimento gravado", async () => {
    const payload = respondiPayload("resp-int-happy-0001", "55 15988880001", "maria.exemplo+0001@example.com");
    const res = await POST(jsonReq(TOKEN_RESPONDI, payload), reqCtx(TOKEN_RESPONDI));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { lead_id: string } };
    const leadId = json.data.lead_id;
    expect(leadId).toBeTruthy();

    const leadRows = rows(`select * from public.crm_leads where id = '${leadId}'`);
    expect(leadRows.length).toBe(1);
    const lead = leadRows[0]!;
    // Título: empresa + contato — NUNCA um rótulo genérico fixo.
    expect(lead.title).toBe("Exemplo Incorporadora — Maria Exemplo");
    expect(lead.external_id).toBe("respondi:resp-int-happy-0001");
    const cf = lead.custom_fields as Record<string, unknown>;
    expect(cf.company_name).toBe("Exemplo Incorporadora");
    expect(cf.segment).toBe("Incorporadora");
    expect(cf.viable_investment_range).toBe("De R$ 4 mil a R$ 7 mil por mês");
    expect(cf.respondi_score).toBe("55");
    expect(cf.respondi_form_id).toBe("9FiY9mrO");
    expect(cf.consent_marketing_status).toBe("granted");

    const contactRows = rows(`select * from public.contacts where id = '${lead.contact_id}'`);
    expect(contactRows.length).toBe(1);
    const contact = contactRows[0]!;
    expect(contact.phone_number).toBe("+5515988880001");
    expect(contact.email).toBe("maria.exemplo+0001@example.com");
    const consent = contact.consent as { marketing: { granted_at: string | null; source: string | null } };
    expect(consent.marketing.granted_at).not.toBeNull();
    expect(consent.marketing.source).toBe("webhook:respondi");
  });

  it("caso 2 — o MESMO envio (mesmo respondent_id) reenviado não duplica o lead (idempotência via respondent_id)", async () => {
    const payload = respondiPayload("resp-int-idempotent-0002", "55 15988880002", "maria.exemplo+0002@example.com");
    const res1 = await POST(jsonReq(TOKEN_RESPONDI, payload), reqCtx(TOKEN_RESPONDI));
    expect(res1.status).toBe(200);
    const leadId1 = ((await res1.json()) as { data: { lead_id: string } }).data.lead_id;

    const res2 = await POST(jsonReq(TOKEN_RESPONDI, payload), reqCtx(TOKEN_RESPONDI));
    expect(res2.status).toBe(200);
    const leadId2 = ((await res2.json()) as { data: { lead_id: string } }).data.lead_id;

    expect(leadId2).toBe(leadId1);
    const count = Number(
      rows(`select count(*) as n from public.crm_leads where external_id = 'respondi:resp-int-idempotent-0002'`)[0]!
        .n,
    );
    expect(count).toBe(1);
  });

  it("caso 3 — consentimento recusado: lead é criado, a recusa fica CARIMBADA no contato (declined_at) e vira atividade na timeline", async () => {
    const payload = respondiPayload("resp-int-declined-0003", "55 15988880003", "maria.exemplo+0003@example.com", (p) => {
      const respondent = p.respondent as Record<string, unknown>;
      const rawAnswers = respondent.raw_answers as Array<Record<string, unknown>>;
      const legaltext = rawAnswers.find(
        (r) => (r.question as Record<string, unknown>).question_type === "legaltext",
      )!;
      legaltext.answer = "no";
      (respondent.answers as Record<string, unknown>)["Autorização de contato"] = "Não aceito";
    });

    const res = await POST(jsonReq(TOKEN_RESPONDI, payload), reqCtx(TOKEN_RESPONDI));
    expect(res.status).toBe(200);
    const leadId = ((await res.json()) as { data: { lead_id: string } }).data.lead_id;

    const lead = rows(`select * from public.crm_leads where id = '${leadId}'`)[0]!;
    expect((lead.custom_fields as Record<string, unknown>).consent_marketing_status).toBe("declined");

    const contact = rows(`select * from public.contacts where id = '${lead.contact_id}'`)[0]!;
    const consent = contact.consent as {
      marketing: { granted_at: string | null; declined_at?: string | null; source?: string | null };
    };
    // Recusa NUNCA vira concessão por omissão: `granted_at` continua null…
    expect(consent.marketing.granted_at).toBeNull();
    // …mas o "não" precisa ser LEGÍVEL, e null sozinho não é: o DEFAULT da
    // coluna já é `granted_at: null`, então "nunca perguntamos" e "disse não"
    // ficavam com a mesma forma. `declined_at` é o que separa os dois, e é o
    // que a guarda de automação lê (lib/automation/guarda-do-contato.ts).
    expect(consent.marketing.declined_at).toBeTruthy();
    expect(consent.marketing.source).toBe("webhook:respondi");

    const activityRows = rows(
      `select * from public.crm_lead_activities where lead_id = '${leadId}' and type = 'consent_declined'`,
    );
    expect(activityRows.length).toBe(1);
    expect(activityRows[0]!.actor_kind).toBe("system");
  });

  it("caso 3b — quem JÁ era contato e agora recusa também fica carimbado (o ramo que o INSERT não alcança)", async () => {
    // Primeiro envio: concede. Segundo envio, MESMO telefone: recusa.
    // O bloco de consentimento do INSERT só roda pra contato novo — sem a
    // reconciliação do contato existente, a recusa do segundo envio se perderia
    // e a pessoa continuaria marcada como tendo concedido.
    const telefone = "55 15988880031";
    const email = "maria.exemplo+0031@example.com";

    const concede = respondiPayload("resp-int-decl-0031-a", telefone, email);
    const r1 = await POST(jsonReq(TOKEN_RESPONDI, concede), reqCtx(TOKEN_RESPONDI));
    expect(r1.status).toBe(200);
    const lead1 = ((await r1.json()) as { data: { lead_id: string } }).data.lead_id;
    const contactId = rows(`select contact_id from public.crm_leads where id = '${lead1}'`)[0]!
      .contact_id as string;
    const antes = rows(`select consent from public.contacts where id = '${contactId}'`)[0]!
      .consent as { marketing: { granted_at: string | null; declined_at?: string | null } };
    expect(antes.marketing.granted_at).not.toBeNull();
    expect(antes.marketing.declined_at ?? null).toBeNull();

    const recusa = respondiPayload("resp-int-decl-0031-b", telefone, email, (p) => {
      const respondent = p.respondent as Record<string, unknown>;
      const rawAnswers = respondent.raw_answers as Array<Record<string, unknown>>;
      const legaltext = rawAnswers.find(
        (r) => (r.question as Record<string, unknown>).question_type === "legaltext",
      )!;
      legaltext.answer = "no";
      (respondent.answers as Record<string, unknown>)["Autorização de contato"] = "Não aceito";
    });
    const r2 = await POST(jsonReq(TOKEN_RESPONDI, recusa), reqCtx(TOKEN_RESPONDI));
    expect(r2.status).toBe(200);

    // MESMO contato (reuso por telefone), agora com a recusa carimbada.
    const lead2 = ((await r2.json()) as { data: { lead_id: string } }).data.lead_id;
    expect(rows(`select contact_id from public.crm_leads where id = '${lead2}'`)[0]!.contact_id).toBe(
      contactId,
    );
    const depois = rows(`select consent from public.contacts where id = '${contactId}'`)[0]!
      .consent as { marketing: { granted_at: string | null; declined_at?: string | null } };
    expect(depois.marketing.declined_at).toBeTruthy();
    expect(depois.marketing.granted_at).toBeNull();
  });

  it("caso 3c — formulário SEM a pergunta de autorização: nada é carimbado (ninguém perguntou ≠ disse não)", async () => {
    // O mapeador devolve `granted: false` quando não acha a pergunta —
    // leitura defensiva correta, silêncio nunca vira concessão. Mas isso NÃO
    // é recusa: carimbar `declined_at` aqui bloquearia a automação de todo
    // formulário do Respondi que não faz a pergunta.
    const payload = respondiPayload("resp-int-sem-legaltext-0032", "55 15988880032", "maria.exemplo+0032@example.com", (p) => {
      const respondent = p.respondent as Record<string, unknown>;
      respondent.raw_answers = (respondent.raw_answers as Array<Record<string, unknown>>).filter(
        (r) => (r.question as Record<string, unknown>).question_type !== "legaltext",
      );
      const answers = respondent.answers as Record<string, unknown>;
      for (const k of Object.keys(answers)) {
        if (/autoriza|aceito receber|consent/i.test(k)) delete answers[k];
      }
    });

    const res = await POST(jsonReq(TOKEN_RESPONDI, payload), reqCtx(TOKEN_RESPONDI));
    expect(res.status).toBe(200);
    const leadId = ((await res.json()) as { data: { lead_id: string } }).data.lead_id;
    const lead = rows(`select * from public.crm_leads where id = '${leadId}'`)[0]!;

    const contact = rows(`select * from public.contacts where id = '${lead.contact_id}'`)[0]!;
    const consent = contact.consent as {
      marketing: { granted_at: string | null; declined_at?: string | null };
    };
    expect(consent.marketing.granted_at).toBeNull();
    // O ponto do caso: SEM carimbo de recusa.
    expect(consent.marketing.declined_at ?? null).toBeNull();
  });

  it("caso 4 — compatibilidade: o botão interno 'Enviar lead de teste' (payload genérico) continua funcionando sem passar pelo caminho Respondi", async () => {
    // Mesmo payload literal que SourceDetail.tsx manda — bate numa fonte
    // comum (não-Respondi), prova que o normalizador novo não interfere.
    const res = await POST(
      jsonReq(TOKEN_JSON, { nome: "Lead de Teste", telefone: "11999990000", utm_source: "teste" }),
      reqCtx(TOKEN_JSON),
    );
    expect(res.status).toBe(200);
    const leadId = ((await res.json()) as { data: { lead_id: string } }).data.lead_id;
    const lead = rows(`select * from public.crm_leads where id = '${leadId}'`)[0]!;
    expect(lead.title).toBe("Lead de Teste");
  });

  it("caso 5 — campo (empresa) ausente no envio: título cai pro nome, sem quebrar", async () => {
    const payload = respondiPayload("resp-int-sem-empresa-0005", "55 15988880005", "maria.exemplo+0005@example.com", (p) => {
      const respondent = p.respondent as Record<string, unknown>;
      delete (respondent.answers as Record<string, unknown>)["Qual é o nome da sua empresa?"];
    });
    const res = await POST(jsonReq(TOKEN_RESPONDI, payload), reqCtx(TOKEN_RESPONDI));
    expect(res.status).toBe(200);
    const leadId = ((await res.json()) as { data: { lead_id: string } }).data.lead_id;
    const lead = rows(`select * from public.crm_leads where id = '${leadId}'`)[0]!;
    expect(lead.title).toBe("Maria Exemplo");
    expect((lead.custom_fields as Record<string, unknown>).company_name).toBeUndefined();
  });

  it("caso 6 — MESMO e-mail, telefone DIFERENTE: conflito 23505 por e-mail não órfã o lead (achado do fix anterior)", async () => {
    // Pré-semeia um contato ATIVO com um e-mail que o próximo envio vai
    // repetir — telefone deliberadamente diferente do que o payload vai usar,
    // pra garantir que o pré-check por telefone NÃO encontre nada e a rota
    // realmente tente o INSERT (e bata no uniq_contacts_org_email).
    const preexistingId = "dddddddd-7777-4000-8000-000000000001";
    const sharedEmail = "colisao.email@example.com";
    sql(`
      insert into public.contacts (id, organization_id, name, phone_number, email, source)
      values ('${preexistingId}', '${GOV_ORG}', 'Dono Original do E-mail', '+5515900000001', '${sharedEmail}', 'manual')
      on conflict do nothing;
    `);

    const payload = respondiPayload("resp-int-mesmo-email-0006", "55 15900000099", sharedEmail);
    const res = await POST(jsonReq(TOKEN_RESPONDI, payload), reqCtx(TOKEN_RESPONDI));
    expect(res.status).toBe(200);
    const leadId = ((await res.json()) as { data: { lead_id: string } }).data.lead_id;

    const lead = rows(`select * from public.crm_leads where id = '${leadId}'`)[0]!;
    // O CORAÇÃO do fix: contact_id NÃO pode ficar null.
    expect(lead.contact_id).not.toBeNull();
    expect(lead.contact_id).toBe(preexistingId);

    // Nenhum contato NOVO foi criado — reusou o existente por e-mail.
    const emailCount = Number(
      rows(
        `select count(*) as n from public.contacts where organization_id = '${GOV_ORG}' and email_normalized = '${sharedEmail}'`,
      )[0]!.n,
    );
    expect(emailCount).toBe(1);
  });

  it("caso 7 — MESMO telefone: continua reusando o contato existente por telefone (regressão do fallback por e-mail)", async () => {
    const preexistingId = "dddddddd-7777-4000-8000-000000000002";
    const sharedPhone = "+5515900000002";
    sql(`
      insert into public.contacts (id, organization_id, name, phone_number, email, source)
      values ('${preexistingId}', '${GOV_ORG}', 'Dono Original do Telefone', '${sharedPhone}', 'outro.email@example.com', 'manual')
      on conflict do nothing;
    `);

    // Mesmo telefone do contato pré-existente, e-mail NOVO — prova que o
    // telefone continua tendo prioridade sobre e-mail (não troca o contato
    // reusado por um e-mail diferente).
    const payload = respondiPayload("resp-int-mesmo-telefone-0007", "55 15900000002", "email.novo.0007@example.com");
    const res = await POST(jsonReq(TOKEN_RESPONDI, payload), reqCtx(TOKEN_RESPONDI));
    expect(res.status).toBe(200);
    const leadId = ((await res.json()) as { data: { lead_id: string } }).data.lead_id;

    const lead = rows(`select * from public.crm_leads where id = '${leadId}'`)[0]!;
    expect(lead.contact_id).toBe(preexistingId);

    const phoneCount = Number(
      rows(
        `select count(*) as n from public.contacts where organization_id = '${GOV_ORG}' and phone_number = '${sharedPhone}'`,
      )[0]!.n,
    );
    expect(phoneCount).toBe(1);
  });

  it("caso 8 — organizações DIFERENTES: mesmo e-mail e mesmo telefone em duas orgs nunca se cruzam", async () => {
    const sharedEmail = "cross.org@example.com";
    const sharedPhoneDigits = "15900000008";

    const payloadOrgA = respondiPayload(
      "resp-int-org-a-0008",
      `55 ${sharedPhoneDigits}`,
      sharedEmail,
    );
    const resA = await POST(jsonReq(TOKEN_RESPONDI, payloadOrgA), reqCtx(TOKEN_RESPONDI));
    expect(resA.status).toBe(200);
    const leadIdA = ((await resA.json()) as { data: { lead_id: string } }).data.lead_id;

    const payloadOrgB = respondiPayload(
      "resp-int-org-b-0008",
      `55 ${sharedPhoneDigits}`,
      sharedEmail,
    );
    const resB = await POST(jsonReq(TOKEN_RESPONDI_B, payloadOrgB), reqCtx(TOKEN_RESPONDI_B));
    expect(resB.status).toBe(200);
    const leadIdB = ((await resB.json()) as { data: { lead_id: string } }).data.lead_id;

    const leadA = rows(`select * from public.crm_leads where id = '${leadIdA}'`)[0]!;
    const leadB = rows(`select * from public.crm_leads where id = '${leadIdB}'`)[0]!;
    expect(leadA.organization_id).toBe(GOV_ORG);
    expect(leadB.organization_id).toBe(WHIN_ORG_B);
    // Contatos DIFERENTES — nenhum vazamento cross-tenant via e-mail/telefone.
    expect(leadA.contact_id).not.toBe(leadB.contact_id);

    const contactA = rows(`select * from public.contacts where id = '${leadA.contact_id}'`)[0]!;
    const contactB = rows(`select * from public.contacts where id = '${leadB.contact_id}'`)[0]!;
    expect(contactA.organization_id).toBe(GOV_ORG);
    expect(contactB.organization_id).toBe(WHIN_ORG_B);
    expect(contactA.email).toBe(sharedEmail);
    expect(contactB.email).toBe(sharedEmail);
  });

  // O caso 8 acima NÃO alcança o `selectActiveByEmail`: com o mesmo telefone nas
  // duas orgs, o INSERT da org B passa limpo (`uniq_contacts_org_phone` é POR
  // organização) e a busca por e-mail nunca roda. Medido sabotando só o
  // `.eq("organization_id", …)` daquele select: a suíte inteira segue verde.
  //
  // Guarda com ponto cego é pior que guarda ausente, porque parece cobertura.
  // Este caso força o ramo: MESMO e-mail, telefone INÉDITO em cada org — que é
  // exatamente quando o INSERT colide em `uniq_contacts_org_email` e o código
  // cai na busca por e-mail para reencontrar o contato.
  it("9. o reencontro POR E-MAIL respeita a organização — o ramo que o caso 8 não alcança", async () => {
    const emailCompartilhado = "ramo.email@example.com";

    // Org A: cria o contato com um telefone próprio.
    const resA = await POST(
      jsonReq(TOKEN_RESPONDI, respondiPayload("resp-int-email-a", "55 15900000009", emailCompartilhado)),
      reqCtx(TOKEN_RESPONDI),
    );
    expect(resA.status).toBe(200);
    const leadA = rows(
      `select * from public.crm_leads where id = '${((await resA.json()) as { data: { lead_id: string } }).data.lead_id}'`,
    )[0]!;

    // Org B: MESMO e-mail, telefone DIFERENTE — o INSERT colide em
    // uniq_contacts_org_email da PRÓPRIA org B só se já houver contato lá; aqui
    // não há, então ele entra. O que este caso prende é que o select por e-mail
    // não pode enxergar o contato da org A em nenhum momento.
    const resB = await POST(
      jsonReq(TOKEN_RESPONDI_B, respondiPayload("resp-int-email-b", "55 15900000010", emailCompartilhado)),
      reqCtx(TOKEN_RESPONDI_B),
    );
    expect(resB.status).toBe(200);
    const leadB = rows(
      `select * from public.crm_leads where id = '${((await resB.json()) as { data: { lead_id: string } }).data.lead_id}'`,
    )[0]!;

    expect(leadA.organization_id).toBe(GOV_ORG);
    expect(leadB.organization_id).toBe(WHIN_ORG_B);
    expect(leadA.contact_id).not.toBe(leadB.contact_id);

    const contatoB = rows(`select * from public.contacts where id = '${leadB.contact_id}'`)[0]!;
    expect(contatoB.organization_id, "o contato da org B nasceu na org errada").toBe(WHIN_ORG_B);

    // A prova de que o ramo foi exercitado: um SEGUNDO envio na org B, com o
    // mesmo e-mail e outro telefone, tem de REENCONTRAR o contato de B — e não
    // criar um terceiro nem colidir com o da org A.
    const resB2 = await POST(
      jsonReq(TOKEN_RESPONDI_B, respondiPayload("resp-int-email-b2", "55 15900000011", emailCompartilhado)),
      reqCtx(TOKEN_RESPONDI_B),
    );
    expect(resB2.status).toBe(200);
    const leadB2 = rows(
      `select * from public.crm_leads where id = '${((await resB2.json()) as { data: { lead_id: string } }).data.lead_id}'`,
    )[0]!;
    expect(leadB2.contact_id, "o reencontro por e-mail não achou o contato da própria org").toBe(
      leadB.contact_id,
    );

    const contatosComEsseEmail = rows(
      `select organization_id from public.contacts where email_normalized = '${emailCompartilhado}' and is_merged_into is null order by organization_id`,
    );
    expect(contatosComEsseEmail, "deveria haver exatamente um contato por organização").toHaveLength(2);
  });
});

/**
 * Classificação inicial (lib/leads/classificacao-inicial.ts), integrada na
 * mesma rota. `CONFIG_CLASSIFICACAO_INICIAL` está CONFIRMADO nesta suíte
 * (maxScoreConhecido: 100, bandas A≥70/B 40-69/C 1-39 — decisão de Matheus,
 * 2026-08-25) — os casos abaixo provam os 2 motivos exatos de
 * desqualificação (só bloqueio técnico/legal real), os 3 sinais de revisão
 * humana (nenhum bloqueia envio), e a classificação A/B/C/D de verdade,
 * inclusive o caso que motivou a segunda rodada da decisão: orçamento baixo
 * sozinho NÃO força D.
 */
describe("POST /api/v1/webhooks/in/[token] — classificação inicial (2026-08-25)", () => {
  it("caso 9 — 'Ainda não posso investir' NÃO desqualifica: vira classe D (sinal forte, lead continua no CRM)", async () => {
    const payload = respondiPayload("resp-int-classe-d-0009", "55 15988880009", "maria.exemplo+0009@example.com", (p) => {
      const respondent = p.respondent as Record<string, unknown>;
      (respondent.answers as Record<string, unknown>)[
        "Considerando estratégia, tecnologia, atendimento e mídia, qual faixa de investimento seria viável para sua empresa crescer?"
      ] = "Ainda não posso investir";
    });
    const res = await POST(jsonReq(TOKEN_RESPONDI, payload), reqCtx(TOKEN_RESPONDI));
    expect(res.status).toBe(200);
    const leadId = ((await res.json()) as { data: { lead_id: string } }).data.lead_id;

    const lead = rows(`select * from public.crm_leads where id = '${leadId}'`)[0]!;
    const cf = lead.custom_fields as Record<string, unknown>;
    expect(cf.classificacao_inicial_status).toBe("classificado");
    expect(cf.classificacao_inicial_classe).toBe("D");

    // Não é mais desqualificação — não deve existir atividade lead_disqualified.
    const activityRows = rows(
      `select id from public.crm_lead_activities where lead_id = '${leadId}' and type = 'lead_disqualified'`,
    );
    expect(activityRows).toHaveLength(0);
  });

  it("caso 9b — REGRESSÃO: faixa de orçamento baixa mas SEM a frase exata não força D — score decide (fixture: score 55 → classe B)", async () => {
    // Este é o caso que Matheus rejeitou na primeira versão da regra: uma
    // empresa de alto potencial que declara orçamento inicial modesto não
    // pode despencar pra D só por causa deste UM campo.
    const payload = respondiPayload("resp-int-nao-forca-d-0009b", "55 15988880019", "maria.exemplo+0019@example.com", (p) => {
      const respondent = p.respondent as Record<string, unknown>;
      const answers = respondent.answers as Record<string, unknown>;
      answers[
        "Considerando estratégia, tecnologia, atendimento e mídia, qual faixa de investimento seria viável para sua empresa crescer?"
      ] = "Até R$ 2 mil";
      // Coerente com a faixa viável acima — sem isto o padrão da fixture
      // ("investe hoje" R$5-10mil > "viável" R$2mil) dispara
      // incoerencia_investimento, que não é o que este caso testa.
      answers["Quanto sua empresa investe atualmente em marketing por mês?"] = "Até R$ 2 mil";
    });
    const res = await POST(jsonReq(TOKEN_RESPONDI, payload), reqCtx(TOKEN_RESPONDI));
    expect(res.status).toBe(200);
    const leadId = ((await res.json()) as { data: { lead_id: string } }).data.lead_id;

    const lead = rows(`select * from public.crm_leads where id = '${leadId}'`)[0]!;
    const cf = lead.custom_fields as Record<string, unknown>;
    expect(cf.classificacao_inicial_classe, "orçamento baixo sozinho não pode forçar D").not.toBe("D");
    expect(cf.classificacao_inicial_classe).toBe("B");
    expect(cf.classificacao_inicial_percentual).toBe("55");
  });

  it("caso 10 — consentimento recusado desqualifica a classificação (motivo sem_consentimento), além de gerar consent_declined", async () => {
    const payload = respondiPayload("resp-int-desq-consent-0010", "55 15988880010", "maria.exemplo+0010@example.com", (p) => {
      const respondent = p.respondent as Record<string, unknown>;
      const rawAnswers = respondent.raw_answers as Array<Record<string, unknown>>;
      const legaltext = rawAnswers.find(
        (r) => (r.question as Record<string, unknown>).question_type === "legaltext",
      )!;
      legaltext.answer = "no";
      (respondent.answers as Record<string, unknown>)["Autorização de contato"] = "Não aceito";
    });
    const res = await POST(jsonReq(TOKEN_RESPONDI, payload), reqCtx(TOKEN_RESPONDI));
    expect(res.status).toBe(200);
    const leadId = ((await res.json()) as { data: { lead_id: string } }).data.lead_id;

    const lead = rows(`select * from public.crm_leads where id = '${leadId}'`)[0]!;
    const cf = lead.custom_fields as Record<string, unknown>;
    expect(cf.classificacao_inicial_status).toBe("desqualificado");
    expect(cf.classificacao_inicial_motivo).toBe("sem_consentimento");

    const disqualified = rows(
      `select id from public.crm_lead_activities where lead_id = '${leadId}' and type = 'lead_disqualified'`,
    );
    expect(disqualified.length).toBe(1);
  });

  it("caso 10b — formulário SEM a pergunta de autorização: NÃO desqualifica (ninguém perguntou ≠ disse não)", async () => {
    // `extractConsent` devolve `granted: false` quando não acha a pergunta —
    // leitura defensiva correta. Tratar isso como recusa desqualificaria todo
    // lead de um formulário do Respondi que não faz a pergunta, e um formulário
    // assim é normal (nem toda captação pede autorização no próprio form).
    const payload = respondiPayload("resp-int-sem-pergunta-0010b", "55 15988880018", "maria.exemplo+0018@example.com", (p) => {
      const respondent = p.respondent as Record<string, unknown>;
      respondent.raw_answers = (respondent.raw_answers as Array<Record<string, unknown>>).filter(
        (r) => (r.question as Record<string, unknown>).question_type !== "legaltext",
      );
      const answers = respondent.answers as Record<string, unknown>;
      for (const k of Object.keys(answers)) {
        if (/autoriza|aceito receber|consent/i.test(k)) delete answers[k];
      }
    });
    const res = await POST(jsonReq(TOKEN_RESPONDI, payload), reqCtx(TOKEN_RESPONDI));
    expect(res.status).toBe(200);
    const leadId = ((await res.json()) as { data: { lead_id: string } }).data.lead_id;

    const lead = rows(`select * from public.crm_leads where id = '${leadId}'`)[0]!;
    const cf = lead.custom_fields as Record<string, unknown>;
    expect(cf.classificacao_inicial_status).not.toBe("desqualificado");
    expect(cf.classificacao_inicial_motivo ?? null).not.toBe("sem_consentimento");

    // E nenhuma atividade de desqualificação — a timeline não pode contar uma
    // história que não aconteceu.
    const disqualified = rows(
      `select id from public.crm_lead_activities where lead_id = '${leadId}' and type = 'lead_disqualified'`,
    );
    expect(disqualified.length).toBe(0);
  });

  it("caso 11 — segundo envio com o MESMO telefone mas nome diferente do contato existente: revisão humana, lead ainda criado", async () => {
    const telefone = "55 15988880011";
    const primeiro = respondiPayload("resp-int-rev-a-0011", telefone, "maria.exemplo+0011a@example.com");
    const res1 = await POST(jsonReq(TOKEN_RESPONDI, primeiro), reqCtx(TOKEN_RESPONDI));
    expect(res1.status).toBe(200);

    const segundo = respondiPayload("resp-int-rev-b-0011", telefone, "maria.exemplo+0011b@example.com", (p) => {
      const respondent = p.respondent as Record<string, unknown>;
      (respondent.answers as Record<string, unknown>)["Qual é o seu nome?"] = "Outra Pessoa Completamente Diferente";
      const rawAnswers = respondent.raw_answers as Array<Record<string, unknown>>;
      const nameAnswer = rawAnswers.find((r) => (r.question as Record<string, unknown>).question_type === "name")!;
      nameAnswer.answer = "Outra Pessoa Completamente Diferente";
    });
    const res2 = await POST(jsonReq(TOKEN_RESPONDI, segundo), reqCtx(TOKEN_RESPONDI));
    expect(res2.status).toBe(200);
    const leadId2 = ((await res2.json()) as { data: { lead_id: string } }).data.lead_id;

    const lead2 = rows(`select * from public.crm_leads where id = '${leadId2}'`)[0]!;
    const cf2 = lead2.custom_fields as Record<string, unknown>;
    expect(cf2.classificacao_inicial_status).toBe("revisao_humana");
    expect(cf2.classificacao_inicial_motivo).toBe("conflito_de_identidade");

    const reviewRows = rows(
      `select id from public.crm_lead_activities where lead_id = '${leadId2}' and type = 'lead_needs_review'`,
    );
    expect(reviewRows.length).toBe(1);
  });

  it("caso 12 — sem respondi_score no envio: lead válido classifica como nao_avaliado, nunca uma classe adivinhada", async () => {
    const payload = respondiPayload("resp-int-naoavaliado-0012", "55 15988880012", "maria.exemplo+0012@example.com", (p) => {
      const respondent = p.respondent as Record<string, unknown>;
      delete respondent.score;
      // Coerente com a faixa viável padrão da fixture (R$4-7mil) — sem isto o
      // padrão ("investe hoje" R$5-10mil > "viável" R$4-7mil) dispara
      // incoerencia_investimento, que não é o que este caso testa.
      (respondent.answers as Record<string, unknown>)["Quanto sua empresa investe atualmente em marketing por mês?"] =
        "Até R$ 2 mil";
    });
    const res = await POST(jsonReq(TOKEN_RESPONDI, payload), reqCtx(TOKEN_RESPONDI));
    expect(res.status).toBe(200);
    const leadId = ((await res.json()) as { data: { lead_id: string } }).data.lead_id;

    const lead = rows(`select * from public.crm_leads where id = '${leadId}'`)[0]!;
    const cf = lead.custom_fields as Record<string, unknown>;
    expect(cf.classificacao_inicial_status).toBe("classificado");
    expect(cf.classificacao_inicial_classe).toBe("nao_avaliado");
    expect(cf.classificacao_inicial_percentual).toBeUndefined();

    // "nao_avaliado" não é evento — não deveria ter gerado lead_disqualified
    // nem lead_needs_review.
    const activityRows = rows(
      `select type from public.crm_lead_activities where lead_id = '${leadId}' and type in ('lead_disqualified', 'lead_needs_review')`,
    );
    expect(activityRows).toHaveLength(0);
  });

  it("caso 13 — envio padrão da fixture (score 55): classifica como B, e a classe fica visível no lead", async () => {
    const payload = respondiPayload("resp-int-classe-b-0013", "55 15988880013", "maria.exemplo+0013@example.com", (p) => {
      const respondent = p.respondent as Record<string, unknown>;
      // Coerente com a faixa viável padrão da fixture (R$4-7mil) — sem isto o
      // padrão ("investe hoje" R$5-10mil > "viável" R$4-7mil) dispara
      // incoerencia_investimento, que não é o que este caso testa.
      (respondent.answers as Record<string, unknown>)["Quanto sua empresa investe atualmente em marketing por mês?"] =
        "Até R$ 2 mil";
    });
    const res = await POST(jsonReq(TOKEN_RESPONDI, payload), reqCtx(TOKEN_RESPONDI));
    expect(res.status).toBe(200);
    const leadId = ((await res.json()) as { data: { lead_id: string } }).data.lead_id;

    const lead = rows(`select * from public.crm_leads where id = '${leadId}'`)[0]!;
    const cf = lead.custom_fields as Record<string, unknown>;
    expect(cf.classificacao_inicial_status).toBe("classificado");
    expect(cf.classificacao_inicial_classe).toBe("B");
    expect(cf.classificacao_inicial_percentual).toBe("55");
  });

  it("caso 14 — nome com sinal de spam: revisão humana (spam_suspeito), não bloqueia a criação do lead", async () => {
    const payload = respondiPayload("resp-int-spam-0014", "55 15988880014", "maria.exemplo+0014@example.com", (p) => {
      const respondent = p.respondent as Record<string, unknown>;
      (respondent.answers as Record<string, unknown>)["Qual é o seu nome?"] = "aaaaaaaa";
      const rawAnswers = respondent.raw_answers as Array<Record<string, unknown>>;
      const nameAnswer = rawAnswers.find((r) => (r.question as Record<string, unknown>).question_type === "name")!;
      nameAnswer.answer = "aaaaaaaa";
    });
    const res = await POST(jsonReq(TOKEN_RESPONDI, payload), reqCtx(TOKEN_RESPONDI));
    expect(res.status).toBe(200);
    const leadId = ((await res.json()) as { data: { lead_id: string } }).data.lead_id;

    const lead = rows(`select * from public.crm_leads where id = '${leadId}'`)[0]!;
    const cf = lead.custom_fields as Record<string, unknown>;
    expect(cf.classificacao_inicial_status).toBe("revisao_humana");
    expect(cf.classificacao_inicial_motivo).toBe("spam_suspeito");

    const reviewRows = rows(
      `select id from public.crm_lead_activities where lead_id = '${leadId}' and type = 'lead_needs_review'`,
    );
    expect(reviewRows.length).toBe(1);
  });

  it("caso 15 — investimento atual maior que o viável declarado: revisão humana (incoerencia_investimento), lead segue elegível pro 1º contato", async () => {
    const payload = respondiPayload("resp-int-incoerencia-0015", "55 15988880015", "maria.exemplo+0015@example.com", (p) => {
      const respondent = p.respondent as Record<string, unknown>;
      const answers = respondent.answers as Record<string, unknown>;
      answers["Quanto sua empresa investe atualmente em marketing por mês?"] = "De R$ 10 mil a R$ 15 mil";
      answers[
        "Considerando estratégia, tecnologia, atendimento e mídia, qual faixa de investimento seria viável para sua empresa crescer?"
      ] = "Até R$ 2 mil";
    });
    const res = await POST(jsonReq(TOKEN_RESPONDI, payload), reqCtx(TOKEN_RESPONDI));
    expect(res.status).toBe(200);
    const leadId = ((await res.json()) as { data: { lead_id: string } }).data.lead_id;

    const lead = rows(`select * from public.crm_leads where id = '${leadId}'`)[0]!;
    const cf = lead.custom_fields as Record<string, unknown>;
    expect(cf.classificacao_inicial_status).toBe("revisao_humana");
    expect(cf.classificacao_inicial_motivo).toBe("incoerencia_investimento");

    // Revisão humana NÃO é gate de envio — guarda-do-contato.ts (telefone +
    // consentimento) é quem decide isso, e não lê classificação nenhuma. A
    // prova de que o lead segue elegível é o consentimento ter sido gravado
    // normalmente, igual a qualquer outro envio com aceite.
    const contact = rows(`select consent from public.contacts where id = '${lead.contact_id}'`)[0]!;
    const consent = contact.consent as { marketing: { granted_at: string | null } };
    expect(consent.marketing.granted_at).not.toBeNull();
  });
});

/**
 * POST /api/v1/webhooks/in/[token] — RD Station (envelope `leads[]`, achado 2026-09-08).
 *
 * Mesma figura do bloco Respondi acima: o payload real do RD Station vem em
 * `{ leads: [ {...} ] }` e o mapeador GENÉRICO só lê chave de topo, então os
 * três campos batiam null e a rota devolvia 400 — 5 recebimentos reais
 * recusados, 0 lead (checkpoint JBA-RDSTATION-WEBHOOK-DIAGNOSTICO.txt). O
 * normalizador dedicado (`lib/webhooks/rdstation.ts`) reconhece o envelope,
 * extrai identidade dos caminhos comprovados e deriva a chave de idempotência
 * `rdstation:evt:<event_uuid>` (fallback `rdstation:lead:<id>`), que reusa o
 * índice `uniq_crm_leads_org_source_external` já existente — sem migration.
 */
function rdStationEnvelope(opts: {
  name?: string | null;
  email?: string | null;
  mobilePhone?: string | null;
  celular?: string | null;
  eventUuid?: string | null;
  leadId?: string;
}) {
  const eventUuid = opts.eventUuid === undefined ? "22222222-2222-4222-8222-000000000001" : opts.eventUuid;
  const celular = opts.celular === undefined ? "+55 (11) 98888-7777" : opts.celular;
  const content: Record<string, unknown> = {
    event_type: "CONVERSION",
    identificador: "jardim-bela-aurora",
    conversion_identifier: "jardim-bela-aurora",
    conversion_url: "https://viver.example.com.br/jardim-bela-aurora",
    email_lead: opts.email === undefined ? "maria.rd@example.com" : opts.email,
    Nome: opts.name === undefined ? "Maria RD" : opts.name,
    Celular: celular,
    phone_lead: null,
  };
  if (eventUuid) {
    content.__cdp__original_event = {
      event_uuid: eventUuid,
      event_batch_uuid: "33333333-3333-4333-8333-000000000001",
      event_type: "CONVERSION",
      event_family: "CDP",
    };
  }
  return {
    leads: [
      {
        id: opts.leadId ?? "5035951450",
        uuid: "11111111-1111-4111-8111-000000000001",
        name: opts.name === undefined ? "Maria RD" : opts.name,
        email: opts.email === undefined ? "maria.rd@example.com" : opts.email,
        phone: null,
        personal_phone: null,
        mobile_phone: opts.mobilePhone === undefined ? "+55 (11) 98888-7777" : opts.mobilePhone,
        lead_stage: "Lead",
        public_url: "http://app.rdstation.com.br/leads/public/11111111-1111-4111-8111-000000000001",
        number_conversions: "2",
        custom_fields: {},
        first_conversion: { content },
        last_conversion: { content },
      },
    ],
  };
}

describe("POST /api/v1/webhooks/in/[token] — RD Station (envelope leads[])", () => {
  it("rd 1 — envelope real: cria contato + lead, nome/telefone/email dos caminhos do RD, external_id = rdstation:evt:*, metadados rd_*", async () => {
    const res = await POST(
      jsonReq(TOKEN_RDSTATION, rdStationEnvelope({ eventUuid: "aaaa0001-0000-4000-8000-000000000001", mobilePhone: "+55 (32) 9922-8971" })),
      reqCtx(TOKEN_RDSTATION),
    );
    expect(res.status).toBe(200);
    const leadId = ((await res.json()) as { data: { lead_id: string } }).data.lead_id;

    const lead = rows(`select * from public.crm_leads where id = '${leadId}'`)[0]!;
    expect(lead.source).toBe("webhook");
    expect(lead.organization_id).toBe(GOV_ORG);
    expect(lead.external_id).toBe("rdstation:evt:aaaa0001-0000-4000-8000-000000000001");
    expect(lead.title).toBe("Maria RD");
    const cf = lead.custom_fields as Record<string, unknown>;
    expect(cf.rd_lead_id).toBe("5035951450");
    expect(cf.rd_conversion_identifier).toBe("jardim-bela-aurora");
    expect(cf.rd_event_uuid).toBe("aaaa0001-0000-4000-8000-000000000001");

    const contact = rows(`select * from public.contacts where id = '${lead.contact_id}'`)[0]!;
    // canonicalPhoneBR injeta o 9º dígito no celular BR.
    expect(contact.phone_number).toBe("+5532999228971");
    expect(contact.email).toBe("maria.rd@example.com");
  });

  it("rd 2 — MESMO event_uuid reenviado NÃO duplica: 200 com o lead existente", async () => {
    const payload = rdStationEnvelope({ eventUuid: "aaaa0002-0000-4000-8000-000000000002", leadId: "5035999002" });
    const first = await POST(jsonReq(TOKEN_RDSTATION, payload), reqCtx(TOKEN_RDSTATION));
    const firstId = ((await first.json()) as { data: { lead_id: string } }).data.lead_id;

    const second = await POST(jsonReq(TOKEN_RDSTATION, payload), reqCtx(TOKEN_RDSTATION));
    expect(second.status).toBe(200);
    const secondId = ((await second.json()) as { data: { lead_id: string } }).data.lead_id;
    expect(secondId).toBe(firstId);

    const count = rows(
      `select count(*)::int as n from public.crm_leads where organization_id = '${GOV_ORG}' and external_id = 'rdstation:evt:aaaa0002-0000-4000-8000-000000000002'`,
    )[0]!;
    expect(count.n).toBe(1);
  });

  it("rd 3 — sem event_uuid: usa rdstation:lead:<id> como chave de idempotência", async () => {
    const payload = rdStationEnvelope({ eventUuid: null, leadId: "5035999003" });
    const res = await POST(jsonReq(TOKEN_RDSTATION, payload), reqCtx(TOKEN_RDSTATION));
    expect(res.status).toBe(200);
    const leadId = ((await res.json()) as { data: { lead_id: string } }).data.lead_id;
    const lead = rows(`select external_id from public.crm_leads where id = '${leadId}'`)[0]!;
    expect(lead.external_id).toBe("rdstation:lead:5035999003");
  });

  it("rd 4 — nome + email e SEM telefone em lugar nenhum: ainda cria lead (regra atual)", async () => {
    const payload = rdStationEnvelope({
      eventUuid: "aaaa0004-0000-4000-8000-000000000004",
      leadId: "5035999004",
      mobilePhone: null,
      celular: null,
    });
    const res = await POST(jsonReq(TOKEN_RDSTATION, payload), reqCtx(TOKEN_RDSTATION));
    expect(res.status).toBe(200);
    const leadId = ((await res.json()) as { data: { lead_id: string } }).data.lead_id;
    const lead = rows(`select * from public.crm_leads where id = '${leadId}'`)[0]!;
    expect(lead.title).toBe("Maria RD");
    expect(lead.contact_id).toBeNull(); // sem telefone → contato não é criado (mesma regra do genérico)
  });

  it("rd 5 — sem identidade nenhuma (nome/email/telefone ausentes): 400 invalid_request, sem lead", async () => {
    const payload = rdStationEnvelope({
      eventUuid: "aaaa0005-0000-4000-8000-000000000005",
      leadId: "5035999005",
      name: null,
      email: null,
      mobilePhone: null,
      celular: null,
    });
    const res = await POST(jsonReq(TOKEN_RDSTATION, payload), reqCtx(TOKEN_RDSTATION));
    expect(res.status).toBe(400);
    const n = rows(
      `select count(*)::int as n from public.crm_leads where organization_id = '${GOV_ORG}' and external_id = 'rdstation:evt:aaaa0005-0000-4000-8000-000000000005'`,
    )[0]!;
    expect(n.n).toBe(0);
  });

  it("rd 6 — isolamento: MESMO event_uuid em org A e org B cria DOIS leads distintos", async () => {
    const uuid = "aaaa0006-0000-4000-8000-000000000006";
    const resA = await POST(
      jsonReq(TOKEN_RDSTATION, rdStationEnvelope({ eventUuid: uuid, leadId: "5035999006", email: "orga.rd@example.com" })),
      reqCtx(TOKEN_RDSTATION),
    );
    const resB = await POST(
      jsonReq(TOKEN_RDSTATION_B, rdStationEnvelope({ eventUuid: uuid, leadId: "5035999006", email: "orgb.rd@example.com" })),
      reqCtx(TOKEN_RDSTATION_B),
    );
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const idA = ((await resA.json()) as { data: { lead_id: string } }).data.lead_id;
    const idB = ((await resB.json()) as { data: { lead_id: string } }).data.lead_id;
    expect(idA).not.toBe(idB);
    const orgA = rows(`select organization_id from public.crm_leads where id = '${idA}'`)[0]!;
    const orgB = rows(`select organization_id from public.crm_leads where id = '${idB}'`)[0]!;
    expect(orgA.organization_id).toBe(GOV_ORG);
    expect(orgB.organization_id).toBe(WHIN_ORG_B);
  });

  it("rd 7 — payload FLAT no mesmo endpoint continua caindo no mapeador genérico (sem regressão)", async () => {
    const res = await POST(
      jsonReq(TOKEN_RDSTATION, { nome: "Flat No RD Source", telefone: "11955550007" }),
      reqCtx(TOKEN_RDSTATION),
    );
    expect(res.status).toBe(200);
    const leadId = ((await res.json()) as { data: { lead_id: string } }).data.lead_id;
    const lead = rows(`select external_id, title from public.crm_leads where id = '${leadId}'`)[0]!;
    expect(lead.title).toBe("Flat No RD Source");
    expect(lead.external_id).toBeNull(); // genérico sem external_id de topo
  });
});
