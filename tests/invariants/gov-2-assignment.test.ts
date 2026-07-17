import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_LEAD,
  GOV_ORG,
  columnExists,
  seedGov,
  sql,
} from "./gov-helpers";

/**
 * Eixo 2 — Atribuição (spec 13 §1; fase que fecha: G3).
 * docs/specs/13-spec-governanca-atendimento.md — dor: "lead/conversa sem
 * registro de quem atende; card sem responsável". Estado atual inventariado
 * na spec 13 §2 (assigned_to_user_id / owner_user_id).
 */

beforeAll(() => {
  seedGov();
});

describe("eixo 2 — atribuição", () => {
  it("conversations tem assigned_to_user_id + assigned_at, com FK para auth.users", () => {
    expect(columnExists("conversations", "assigned_to_user_id")).toBe(true);
    expect(columnExists("conversations", "assigned_at")).toBe(true);
    const fk = sql(
      `select exists(select 1 from pg_constraint where conname = 'conversations_assigned_to_user_id_fkey');`,
    );
    expect(fk).toBe("t");
  });

  it("crm_leads tem owner_user_id (responsável de 1ª classe no card)", () => {
    expect(columnExists("crm_leads", "owner_user_id")).toBe(true);
  });

  it("mudança de owner em crm_leads emite lead.assigned no event_log (trigger, nunca HTTP)", () => {
    sql(
      `update public.crm_leads set owner_user_id = '${GOV_AGENT_A}' where id = '${GOV_LEAD}';`,
    );
    const events = Number(
      sql(
        `select count(*) from public.event_log
           where organization_id = '${GOV_ORG}'
             and event_type = 'lead.assigned'
             and payload ->> 'lead_id' = '${GOV_LEAD}';`,
      ),
    );
    expect(events).toBeGreaterThanOrEqual(1);
  });
});
