import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_AGENT_B, GOV_MANAGER, countAs, seedGov, sql, writeCountAs } from "./gov-helpers";

/**
 * Issue #2547 — no modo "Só os seus" (`visibility_mode = 'own'`) o Atendente
 * não conseguia criar negócio pelo "Novo Lead": o negócio nascia SEM dono, e a
 * policy `crm_leads_insert` (via `fn_can_view_lead`) recusava a linha que ele
 * não enxergaria depois de gravada.
 *
 * Decisão do mantenedor (opção A): o negócio que o Atendente cria nesse modo
 * nasce com ELE de responsável — `app/api/v1/leads/route.ts` preenche o
 * `owner_user_id`. Este arquivo mede o lado do banco dessa decisão:
 *
 *   - a regra JÁ aceita o Atendente como dono de si mesmo, sem migration;
 *   - sem dono e com dono colega a recusa continua (é o 403 explicado do #2556);
 *   - o negócio criado não vaza para o colega nem para outra organização.
 *
 * Fixtures próprias (namespace a2547…), org dedicada em 'own' para não mexer no
 * `visibility_mode` do GOV_ORG, que é compartilhado com outros arquivos.
 */

const ORG = "a2547000-0000-4000-8000-000000000001";
const PIPELINE = "a2547000-0000-4000-8000-000000000002";
const STAGE = "a2547000-0000-4000-8000-000000000003";
const LEAD_DO_A = "a2547000-0000-4000-8000-000000000004";

beforeAll(() => {
  seedGov(); // auth.users de GOV_AGENT_A/B e GOV_MANAGER (este, só do GOV_ORG)
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name, settings)
      values ('${ORG}', 'inv-2547-own', 'Inv 2547 Own', 'Inv 2547',
              jsonb_build_object('visibility_mode', 'own'))
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${GOV_AGENT_A}', '${ORG}', 'agent', now()),
             ('${GOV_AGENT_B}', '${ORG}', 'agent', now())
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPELINE}', '${ORG}', 'Inv 2547', 'inv-2547')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${STAGE}', '${ORG}', '${PIPELINE}', 'Novo', 'novo', 1000)
      on conflict do nothing;
  `);
});

describe("#2547 — o Atendente cria negócio no modo 'Só os seus'", () => {
  it("sem dono, a regra recusa (a recusa original da issue)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, owner_user_id)
           values ('${ORG}', '${PIPELINE}', '${STAGE}', 'Sem dono', null)`,
      ),
    ).toBe(0);
  });

  it("com ele mesmo de dono, a regra aceita sem migration, e ele vê o negócio", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.crm_leads
           (id, organization_id, pipeline_id, stage_id, title, owner_user_id, owner_kind, assigned_at)
           values ('${LEAD_DO_A}', '${ORG}', '${PIPELINE}', '${STAGE}', 'Criado pelo agent A',
                   '${GOV_AGENT_A}', 'user', now())`,
      ),
    ).toBe(1);
    expect(countAs(GOV_AGENT_A, `select count(*) from public.crm_leads where id = '${LEAD_DO_A}';`)).toBe(1);
  });

  it("com um colega da MESMA organização de dono, a regra recusa", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, owner_user_id)
           values ('${ORG}', '${PIPELINE}', '${STAGE}', 'Pro colega', '${GOV_AGENT_B}')`,
      ),
    ).toBe(0);
  });

  it("o negócio do agent A não aparece para o colega nem para outra organização", () => {
    // Depende do caso de criação acima (mesmo arquivo, ordem sequencial).
    expect(countAs(GOV_AGENT_B, `select count(*) from public.crm_leads where id = '${LEAD_DO_A}';`)).toBe(0);
    // Gerente do GOV_ORG, que não é membro desta org: isolamento entre organizações.
    expect(countAs(GOV_MANAGER, `select count(*) from public.crm_leads where id = '${LEAD_DO_A}';`)).toBe(0);
  });
});
