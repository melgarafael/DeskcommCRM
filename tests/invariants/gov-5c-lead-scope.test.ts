import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
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
 * Eixo 5 — Escopo de visualização/escrita no kanban/leads (spec 13 §4 linha 220;
 * fecha em G4-03). Espelho de gov-5 (conversations, G4-01) para crm_leads: o
 * "dono" do lead é owner_user_id (não assigned_to). A RLS (migration 0036) aplica
 * fn_can_view_lead no SELECT e nas policies de escrita por-role: só o role `agent`
 * é restrito por organizations.settings.visibility_mode; viewer/manager/admin
 * seguem org-wide. Cobre READ e WRITE, incl. o lead SEM dono (owner=null) nos dois
 * modos (own_and_unassigned = a fila que o agent puxa: vê E move; own = nem vê nem
 * move — espelho exato das conversas).
 *
 * Fixtures locais (namespace a5c… — exclusivo deste arquivo, paralelo aos demais
 * gov-*.test.ts). GOV_LEAD do helper NÃO é usado: gov-2-assignment muta o owner
 * dele em paralelo. Leads próprios com IDs dedicados, escrita = bump de
 * position_in_stage (o exato drag-and-drop de reordenar/mover, sem trigger de
 * stage/close). Sem PII (LGPD): títulos sintéticos.
 */

const LEAD_A = "a5c01111-0000-4000-8000-000000000001"; // owner = GOV_AGENT_A
const LEAD_B = "a5c01111-0000-4000-8000-000000000002"; // owner = GOV_AGENT_B
const LEAD_NULL = "a5c01111-0000-4000-8000-000000000003"; // owner = null (fila), GOV_ORG

// Org dedicada em modo 'own' (fila NÃO conta), com agent A membro + 1 lead sem dono.
const OWN_ORG = "a5c02222-0000-4000-8000-000000000001";
const OWN_PIPELINE = "a5c02222-0000-4000-8000-000000000002";
const OWN_STAGE = "a5c02222-0000-4000-8000-000000000003";
const OWN_LEAD_NULL = "a5c02222-0000-4000-8000-000000000004"; // owner = null, modo 'own'

beforeAll(() => {
  seedGov(); // GOV_ORG (default own_and_unassigned) + agents A/B + manager + pipeline/stage
  sql(`
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id)
      values
        ('${LEAD_A}',    '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Lead do agent A', '${GOV_AGENT_A}'),
        ('${LEAD_B}',    '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Lead do agent B', '${GOV_AGENT_B}'),
        ('${LEAD_NULL}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Lead sem dono (fila)', null)
      on conflict (id) do nothing;

    -- Org em modo 'own': agent A é membro, 1 lead sem dono. Isola o teste de 'own'
    -- sem tocar no visibility_mode do GOV_ORG (compartilhado com outros arquivos).
    insert into public.organizations (id, slug, legal_name, display_name, settings)
      values ('${OWN_ORG}', 'gov-lead-own', 'Gov Lead Own Org', 'Gov Lead Own',
              jsonb_build_object('visibility_mode', 'own'))
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${GOV_AGENT_A}', '${OWN_ORG}', 'agent', now()) on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${OWN_PIPELINE}', '${OWN_ORG}', 'Gov Lead Own', 'gov-lead-own')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${OWN_STAGE}', '${OWN_ORG}', '${OWN_PIPELINE}', 'Novo', 'novo', 1000)
      on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id)
      values ('${OWN_LEAD_NULL}', '${OWN_ORG}', '${OWN_PIPELINE}', '${OWN_STAGE}', 'Lead sem dono (own)', null)
      on conflict (id) do nothing;
  `);
});

describe("eixo 5 — escopo de leads (kanban)", () => {
  // ---- READ ----
  it("agent A NÃO vê lead de outro agent (spec 13 §4 linha 220: agent = own)", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.crm_leads where id = '${LEAD_B}';`),
    ).toBe(0);
  });

  it("agent A vê o próprio lead (controle positivo)", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.crm_leads where id = '${LEAD_A}';`),
    ).toBe(1);
  });

  it("agent A vê o lead sem dono no default 'own_and_unassigned' (G1-06a)", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.crm_leads where id = '${LEAD_NULL}';`),
    ).toBe(1);
  });

  it("agent A NÃO vê o lead sem dono quando visibility_mode='own'", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.crm_leads where id = '${OWN_LEAD_NULL}';`),
    ).toBe(0);
  });

  it("manager vê TODOS os leads da org (org-wide read)", () => {
    expect(
      countAs(
        GOV_MANAGER,
        `select count(*) from public.crm_leads
           where id in ('${LEAD_A}', '${LEAD_B}', '${LEAD_NULL}');`,
      ),
    ).toBe(3);
  });

  // ---- WRITE (drag-and-drop = bump de position_in_stage) ----
  it("agent A MOVE o próprio lead (own:write — drag-and-drop não quebra)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.crm_leads set position_in_stage = position_in_stage + 1 where id = '${LEAD_A}'`,
      ),
    ).toBe(1);
  });

  it("agent A NÃO move lead de outro agent (RLS bloqueia = 0 rows)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.crm_leads set position_in_stage = position_in_stage + 1 where id = '${LEAD_B}'`,
      ),
    ).toBe(0);
  });

  it("agent A MOVE o lead sem dono no 'own_and_unassigned' (puxa a fila)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.crm_leads set position_in_stage = position_in_stage + 1 where id = '${LEAD_NULL}'`,
      ),
    ).toBe(1);
  });

  it("agent A NÃO move o lead sem dono quando visibility_mode='own' (0 rows)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.crm_leads set position_in_stage = position_in_stage + 1 where id = '${OWN_LEAD_NULL}'`,
      ),
    ).toBe(0);
  });

  it("manager MOVE lead de qualquer atendente (org-wide write)", () => {
    expect(
      writeCountAs(
        GOV_MANAGER,
        `update public.crm_leads set position_in_stage = position_in_stage + 1 where id = '${LEAD_B}'`,
      ),
    ).toBe(1);
  });

  // ---- INSERT (criação de lead não quebra) ----
  it("agent A CRIA lead próprio (owner=si) — criação legítima não quebra", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, owner_user_id)
           values ('${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Novo lead do agent A', '${GOV_AGENT_A}')`,
      ),
    ).toBe(1);
  });

  it("agent A NÃO cria lead já atribuído a outro agent (WITH CHECK bloqueia = 0)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, owner_user_id)
           values ('${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Lead pro B', '${GOV_AGENT_B}')`,
      ),
    ).toBe(0);
  });

  it("manager CRIA lead atribuído a qualquer atendente (org-wide, base do bulk assign G3-04)", () => {
    expect(
      writeCountAs(
        GOV_MANAGER,
        `insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, owner_user_id)
           values ('${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Lead atribuído pelo manager', '${GOV_AGENT_B}')`,
      ),
    ).toBe(1);
  });
});
