/**
 * Idempotência do inbound por external_id (spec §5).
 *
 * A fundação é o índice pré-existente `uniq_crm_leads_org_source_external`
 * (organization_id, source, external_id) WHERE external_id IS NOT NULL — este
 * arquivo prova as propriedades DB de que a rota depende:
 *  1. segundo INSERT com o mesmo (org, 'webhook', external_id) → 23505;
 *  2. external_id NULL não deduplica (N leads sem id externo convivem);
 *  3. o MESMO external_id em orgs diferentes convive (escopo por tenant);
 *  4. o mesmo external_id com source diferente convive (webhook ≠ nuvemshop).
 * O comportamento HTTP (200 idempotente, corrida re-selecionada) é provado no
 * E2E por curl contra o dev server (ver HANDOFF).
 *
 * Namespace de fixtures 'ffffffff-d*'.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "./gov-helpers";

const ORG_A = "ffffffff-d000-4000-8000-000000000001";
const ORG_B = "ffffffff-d000-4000-8000-000000000002";
const PIPE_A = "ffffffff-d100-4000-8000-000000000001";
const STAGE_A = "ffffffff-d200-4000-8000-000000000001";
const PIPE_B = "ffffffff-d100-4000-8000-000000000002";
const STAGE_B = "ffffffff-d200-4000-8000-000000000002";

function insertLead(org: string, pipe: string, stage: string, title: string, source: string, externalId: string | null): string {
  const ext = externalId === null ? "null" : `'${externalId}'`;
  return `insert into public.crm_leads
    (organization_id, pipeline_id, stage_id, title, status, position_in_stage, source, external_id)
    values ('${org}', '${pipe}', '${stage}', '${title}', 'open', 1000, '${source}', ${ext});`;
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'gov-inv-idem-a', 'Idem A', 'Idem A'),
      ('${ORG_B}', 'gov-inv-idem-b', 'Idem B', 'Idem B')
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${PIPE_A}', '${ORG_A}', 'Idem A', 'idem-a'),
      ('${PIPE_B}', '${ORG_B}', 'Idem B', 'idem-b')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${STAGE_A}', '${ORG_A}', '${PIPE_A}', 'Novo', 'novo', 1),
      ('${STAGE_B}', '${ORG_B}', '${PIPE_B}', 'Novo', 'novo', 1)
      on conflict do nothing;
  `);
});

describe("idempotência inbound — índice uniq_crm_leads_org_source_external", () => {
  it("1. duplicata (org, webhook, external_id) → 23505", () => {
    sql(insertLead(ORG_A, PIPE_A, STAGE_A, "dup 1", "webhook", "zap-run-001"));
    expect(() =>
      sql(insertLead(ORG_A, PIPE_A, STAGE_A, "dup 2", "webhook", "zap-run-001")),
    ).toThrowError(/uniq_crm_leads_org_source_external|duplicate key/);
    const n = sql(
      `select count(*) from public.crm_leads where organization_id='${ORG_A}' and external_id='zap-run-001';`,
    ).trim();
    expect(n).toBe("1");
  });

  it("2. external_id NULL nunca deduplica", () => {
    sql(insertLead(ORG_A, PIPE_A, STAGE_A, "sem id 1", "webhook", null));
    sql(insertLead(ORG_A, PIPE_A, STAGE_A, "sem id 2", "webhook", null));
    const n = sql(
      `select count(*) from public.crm_leads where organization_id='${ORG_A}' and title like 'sem id %';`,
    ).trim();
    expect(n).toBe("2");
  });

  it("3. mesmo external_id em ORGS diferentes convive (escopo por tenant)", () => {
    sql(insertLead(ORG_B, PIPE_B, STAGE_B, "outro tenant", "webhook", "zap-run-001"));
    const n = sql(
      `select count(*) from public.crm_leads where external_id='zap-run-001';`,
    ).trim();
    expect(n).toBe("2");
  });

  it("4. mesmo external_id com SOURCE diferente convive (webhook ≠ nuvemshop)", () => {
    sql(insertLead(ORG_A, PIPE_A, STAGE_A, "de outra origem", "nuvemshop", "zap-run-001"));
    const n = sql(
      `select count(*) from public.crm_leads where organization_id='${ORG_A}' and external_id='zap-run-001';`,
    ).trim();
    expect(n).toBe("2");
  });
});
