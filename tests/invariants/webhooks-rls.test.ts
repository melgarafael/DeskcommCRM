import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_MANAGER,
  GOV_ORG,
  GOV_PIPELINE,
  GOV_STAGE,
  countAs,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

/**
 * Webhooks + mini motor de regras (migration 0038, spec
 * docs/superpowers/specs/2026-07-17-webhooks-design.md).
 *
 * Invariantes RLS:
 *  - select org-scoped (membro da org ou platform admin) nas 3 tabelas;
 *  - write manager+ em webhook_sources/automation_rules (agent bloqueado);
 *  - automation_rule_runs é select-only p/ authenticated — escrita só via
 *    service_role (bypassa RLS), nunca pelo usuário logado.
 */

// Fixture própria (namespace ffffffff) — org B só p/ provar não-vazamento.
const WH_ORG_B = "ffffffff-0000-4000-8000-000000000002";
const WH_MANAGER_B = "ffffffff-1111-4000-8000-000000000002";
const WH_SOURCE = "ffffffff-5555-4000-8000-000000000001";
const WH_SOURCE_AGENT_PROBE = "ffffffff-5555-4000-8000-000000000002";
const WH_RULE = "ffffffff-5555-4000-8000-000000000003";
const WH_RUN = "ffffffff-5555-4000-8000-000000000004";

beforeAll(() => {
  seedGov();
  sql(`
    insert into auth.users (id, email)
      values ('${WH_MANAGER_B}', 'gov-manager-org-b@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${WH_ORG_B}', 'gov-inv-webhooks-b', 'Gov Invariant Webhooks Org B', 'Gov Inv Webhooks B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${WH_MANAGER_B}', '${WH_ORG_B}', 'manager', now())
      on conflict do nothing;
  `);
});

describe("webhook_sources + automation_rules + automation_rule_runs — RLS (migration 0038)", () => {
  it("manager A cria webhook_source e automation_rule na org A", () => {
    const insertedSource = writeCountAs(
      GOV_MANAGER,
      `insert into public.webhook_sources
         (id, organization_id, name, path_token, default_pipeline_id, default_stage_id)
       values
         ('${WH_SOURCE}', '${GOV_ORG}', 'Landing page', 'wh-tok-${WH_SOURCE}', '${GOV_PIPELINE}', '${GOV_STAGE}')`,
    );
    expect(insertedSource).toBe(1);

    const insertedRule = writeCountAs(
      GOV_MANAGER,
      `insert into public.automation_rules
         (id, organization_id, name, trigger_event)
       values
         ('${WH_RULE}', '${GOV_ORG}', 'Notifica novo lead', 'lead.created')`,
    );
    expect(insertedRule).toBe(1);
  });

  it("manager B (org B) NÃO vê webhook_source/automation_rule da org A", () => {
    expect(
      countAs(
        WH_MANAGER_B,
        `select count(*) from public.webhook_sources where id = '${WH_SOURCE}';`,
      ),
    ).toBe(0);
    expect(
      countAs(WH_MANAGER_B, `select count(*) from public.automation_rules where id = '${WH_RULE}';`),
    ).toBe(0);
  });

  it("agent A NÃO consegue INSERT em webhook_sources (write é manager+)", () => {
    const inserted = writeCountAs(
      GOV_AGENT_A,
      `insert into public.webhook_sources
         (id, organization_id, name, path_token, default_pipeline_id, default_stage_id)
       values
         ('${WH_SOURCE_AGENT_PROBE}', '${GOV_ORG}', 'Probe agent', 'wh-tok-${WH_SOURCE_AGENT_PROBE}', '${GOV_PIPELINE}', '${GOV_STAGE}')`,
    );
    expect(inserted).toBe(0);
  });

  it("manager A lê as próprias linhas (1 cada)", () => {
    expect(
      countAs(GOV_MANAGER, `select count(*) from public.webhook_sources where id = '${WH_SOURCE}';`),
    ).toBe(1);
    expect(
      countAs(GOV_MANAGER, `select count(*) from public.automation_rules where id = '${WH_RULE}';`),
    ).toBe(1);
  });

  it("service_role insere automation_rule_runs na org A; manager B não vê, manager A vê", () => {
    // ponytail: sql() roda como o superuser do container (bypassa RLS), o
    // mesmo efeito prático do service_role em produção — não há client
    // service_role real neste harness de invariantes.
    sql(`
      insert into public.automation_rule_runs (id, organization_id, rule_id, status)
        values ('${WH_RUN}', '${GOV_ORG}', '${WH_RULE}', 'success');
    `);

    expect(
      countAs(WH_MANAGER_B, `select count(*) from public.automation_rule_runs where id = '${WH_RUN}';`),
    ).toBe(0);
    expect(
      countAs(GOV_MANAGER, `select count(*) from public.automation_rule_runs where id = '${WH_RUN}';`),
    ).toBe(1);
  });

  it("manager A NÃO consegue INSERT direto em automation_rule_runs (select-only p/ authenticated)", () => {
    const inserted = writeCountAs(
      GOV_MANAGER,
      `insert into public.automation_rule_runs (organization_id, rule_id, status)
       values ('${GOV_ORG}', '${WH_RULE}', 'success')`,
    );
    expect(inserted).toBe(0);
  });
});
