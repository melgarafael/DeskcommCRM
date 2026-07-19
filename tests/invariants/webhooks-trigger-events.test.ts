import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { moveLeadHandler, updateLeadHandler } from "@/app/api/v1/leads/_handler";
import { patchContactHandler } from "@/app/api/v1/contacts/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { GOV_MANAGER, GOV_ORG, GOV_PIPELINE, GOV_STAGE, seedGov, sql } from "./gov-helpers";

/**
 * Task 3 (spec webhooks/automação 2026-07-17) — emissões de gatilho faltantes
 * nos fluxos existentes: `lead.stage_changed` (moveLeadHandler), `lead.tag_added`
 * (updateLeadHandler) e `contact.tag_added` (patchContactHandler). Payloads são
 * o contrato congelado que o motor de regras (Task 7) vai consumir.
 *
 * `message.received` (handleInbound em lib/waha/ingest.ts) fica FORA deste
 * harness: a função não é exportada e o ingest depende de RPCs de identidade
 * (fn_upsert_wa_contact/fn_upsert_wa_conversation) que este double não replica
 * — ver nota no relatório da task sobre a verificação manual desse trecho.
 *
 * Mesma limitação de infra documentada em webhooks-rls.test.ts /
 * event-log-drain.test.ts: o harness sobe só um Postgres cru (sem PostgREST/
 * HTTP). `fakeAdminClient()` é um double mínimo do shape que os 3 handlers
 * efetivamente usam (.from().select()/.update()/.eq()/.maybeSingle(), .rpc()),
 * traduzido pra SQL via o mesmo `sql()` (docker exec psql) que o resto da
 * suíte usa. `audit()` dentro dos handlers tenta um client Supabase real
 * (admin, via lib/supabase/admin) contra uma URL fake configurada em
 * vitest.db.config.ts (`test.env`) — a chamada de rede falha rápido
 * (ECONNREFUSED) e é engolida pelo try/catch interno de `audit()`; não afeta
 * o teste.
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

type QResult = { data: unknown; error: { message: string } | null };

/** Double mínimo de um PostgrestQueryBuilder — só os métodos que os handlers usam. */
class FakeQB {
  private mode: "select" | "update" = "select";
  private cols = "*";
  private selectAfterUpdate = "*";
  private updateData: Record<string, unknown> | null = null;
  private filters: string[] = [];

  constructor(private table: string) {}

  select(cols: string): this {
    if (this.mode === "update") {
      this.selectAfterUpdate = cols;
      return this;
    }
    this.cols = cols;
    return this;
  }

  update(data: Record<string, unknown>): this {
    this.mode = "update";
    this.updateData = data;
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push(`${col} = ${sqlLiteral(val)}`);
    return this;
  }

  private where(): string {
    return this.filters.length ? ` where ${this.filters.join(" and ")}` : "";
  }

  async maybeSingle(): Promise<QResult> {
    try {
      let query: string;
      if (this.mode === "select") {
        query = `select coalesce(json_agg(t), '[]') from (select ${this.cols} from public.${this.table}${this.where()}) t;`;
      } else {
        const setClauses = Object.entries(this.updateData!)
          .map(([k, v]) => `${k} = ${sqlLiteral(v)}`)
          .join(", ");
        query = `with w as (update public.${this.table} set ${setClauses}${this.where()} returning ${this.selectAfterUpdate}) select coalesce(json_agg(w), '[]') from w;`;
      }
      const out = sql(query);
      const rows = JSON.parse(out || "[]") as Array<Record<string, unknown>>;
      return { data: rows[0] ?? null, error: null };
    } catch (err) {
      return { data: null, error: { message: (err as Error).message } };
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
    from: (table: string) => new FakeQB(table),
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

function eventRows(eventType: string, entityKind: string, entityId: string): Array<{ payload: Record<string, unknown> }> {
  const out = sql(`
    select coalesce(json_agg(t), '[]') from (
      select payload from public.event_log
      where event_type = ${sqlString(eventType)}
        and entity_kind = ${sqlString(entityKind)}
        and entity_id = ${sqlString(entityId)}
      order by created_at
    ) t;
  `);
  return JSON.parse(out || "[]");
}

const ctx: HandlerCtx = {
  organization_id: GOV_ORG,
  actor: { type: "user", id: GOV_MANAGER },
  requestId: "test3-request-id",
};

// Namespace próprio (eeeeeeee-) — reusa GOV_PIPELINE/GOV_STAGE (já seedados
// por seedGov()) como stage de origem; cria um segundo stage + lead + contact
// dedicados a este arquivo.
const T3_STAGE_2 = "eeeeeeee-5555-4000-8000-000000000001";
const T3_LEAD = "eeeeeeee-6666-4000-8000-000000000001";
const T3_CONTACT = "eeeeeeee-3333-4000-8000-000000000001";

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${T3_STAGE_2}', '${GOV_ORG}', '${GOV_PIPELINE}', 'T3 Stage 2', 't3-stage-2', 2000)
      on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title)
      values ('${T3_LEAD}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Task 3 invariant lead')
      on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name)
      values ('${T3_CONTACT}', '${GOV_ORG}', 'Task 3 invariant contact')
      on conflict do nothing;
  `);
});

describe("webhooks trigger events — emissões faltantes (Task 3)", () => {
  it("moveLeadHandler emite lead.stage_changed com pipeline_id/from_stage_id/to_stage_id", async () => {
    await moveLeadHandler(fakeAdminClient(), ctx, T3_LEAD, {
      to_stage_id: T3_STAGE_2,
      position_in_stage: 3000,
    });

    const rows = eventRows("lead.stage_changed", "crm_lead", T3_LEAD);
    expect(rows.length).toBe(1);
    expect(rows[0]!.payload.pipeline_id).toBe(GOV_PIPELINE);
    expect(rows[0]!.payload.from_stage_id).toBe(GOV_STAGE);
    expect(rows[0]!.payload.to_stage_id).toBe(T3_STAGE_2);
  });

  it("updateLeadHandler emite lead.tag_added só quando há tag NOVA", async () => {
    await updateLeadHandler(fakeAdminClient(), ctx, T3_LEAD, { tags: ["vip"] });

    const rows = eventRows("lead.tag_added", "crm_lead", T3_LEAD);
    expect(rows.length).toBe(1);
    expect(rows[0]!.payload.added_tags).toEqual(["vip"]);
    expect(rows[0]!.payload.tags).toEqual(["vip"]);

    // Reenvia a MESMA tag — nenhuma tag nova, nenhuma linha nova.
    await updateLeadHandler(fakeAdminClient(), ctx, T3_LEAD, { tags: ["vip"] });
    expect(eventRows("lead.tag_added", "crm_lead", T3_LEAD).length).toBe(1);
  });

  it("patchContactHandler emite contact.tag_added quando há tag NOVA", async () => {
    await patchContactHandler(fakeAdminClient(), ctx, T3_CONTACT, { tags: ["cliente"] });

    const rows = eventRows("contact.tag_added", "contact", T3_CONTACT);
    expect(rows.length).toBe(1);
    expect(rows[0]!.payload.added_tags).toEqual(["cliente"]);
    expect(rows[0]!.payload.tags).toEqual(["cliente"]);
  });
});
