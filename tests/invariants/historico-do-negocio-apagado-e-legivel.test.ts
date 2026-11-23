import { beforeAll, describe, expect, it } from "vitest";

import { countAs, lastLine, sql } from "./gov-helpers";

/**
 * #4852 — O HISTÓRICO PRESERVADO É LEGÍVEL, MEDIDO PELA RLS.
 *
 * A migration 9466 trocou `crm_lead_activities.lead_id` de `ON DELETE CASCADE`
 * para `ON DELETE SET NULL`: apagar o negócio deixa de apagar a timeline. Só que
 * "sobrevive na tabela" não é "é legível": a policy `crm_lead_activities_select`
 * exige o lead-pai (`EXISTS ... where l.id = lead_id`), e com `lead_id` anulado o
 * `EXISTS` é falso para todo mundo — o admin da própria empresa conta ZERO pelo
 * contato. Medido no PR: `[M2] na_tabela=1|null visivel_ao_admin=0`.
 *
 * O conserto é o braço da policy para a linha ÓRFÃ, no escopo da ORGANIZAÇÃO e
 * para quem já lê a organização inteira (`org_wide_read`). Este arquivo mede pela
 * RLS, e não como superusuário: `countAs` veste o papel `authenticated` com o
 * claim do usuário, que é o caminho que o PostgREST usa em produção. A primeira
 * asserção — a linha existe para o superusuário — é o controle: sem ela, um teste
 * que apagasse a linha passaria com "0 visível" e ninguém saberia.
 *
 * Namespace 9f42.
 */

const ORG = "9f420001-0000-4000-8000-000000000000";
const ORG_ALHEIA = "9f420002-0000-4000-8000-000000000000";
const PIPE = "9f420003-0000-4000-8000-000000000001";
const ETAPA = "9f420003-0000-4000-8000-000000000002";
const CONTATO = "9f420004-0000-4000-8000-000000000001";
const LEAD = "9f420005-0000-4000-8000-000000000001";
const ATIVIDADE = "9f420006-0000-4000-8000-000000000001";

const GERENTE = "9f420010-0000-4000-8000-000000000001";
const ADMIN = "9f420010-0000-4000-8000-000000000002";
const VIEWER = "9f420010-0000-4000-8000-000000000003";
const AGENTE_DONO = "9f420010-0000-4000-8000-000000000004";
const FORASTEIRO = "9f420010-0000-4000-8000-000000000005";

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'inv-9f42', 'Inv 9f42', 'Inv 9f42'),
      ('${ORG_ALHEIA}', 'inv-9f42b', 'Inv 9f42 B', 'Inv 9f42 B')
      on conflict (id) do nothing;

    insert into auth.users (id, email) values
      ('${GERENTE}', 'gerente@inv-9f42.test'),
      ('${ADMIN}', 'admin@inv-9f42.test'),
      ('${VIEWER}', 'viewer@inv-9f42.test'),
      ('${AGENTE_DONO}', 'agente@inv-9f42.test'),
      ('${FORASTEIRO}', 'forasteiro@inv-9f42.test')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${GERENTE}', '${ORG}', 'manager', now()),
      ('${ADMIN}', '${ORG}', 'admin', now()),
      ('${VIEWER}', '${ORG}', 'viewer', now()),
      ('${AGENTE_DONO}', '${ORG}', 'agent', now()),
      ('${FORASTEIRO}', '${ORG_ALHEIA}', 'manager', now())
      on conflict do nothing;

    insert into public.crm_pipelines (id, organization_id, name, slug, position)
      values ('${PIPE}', '${ORG}', 'Funil', 'funil-9f42', 1000)
      on conflict (id) do nothing;

    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${ETAPA}', '${ORG}', '${PIPE}', 'Novo', 'novo-9f42', 1000)
      on conflict (id) do nothing;

    insert into public.contacts (id, organization_id, name)
      values ('${CONTATO}', '${ORG}', 'Ana')
      on conflict (id) do nothing;

    insert into public.crm_leads
      (id, organization_id, pipeline_id, stage_id, title, owner_user_id, contact_id)
    values ('${LEAD}', '${ORG}', '${PIPE}', '${ETAPA}', 'Negócio que vai ser apagado', '${AGENTE_DONO}', '${CONTATO}')
      on conflict (id) do nothing;

    -- A linha de timeline do negócio, com o contato: é por ele que o histórico
    -- continua atribuível depois que o negócio some.
    insert into public.crm_lead_activities
      (id, organization_id, lead_id, contact_id, type, source_module, reason, payload)
    values ('${ATIVIDADE}', '${ORG}', '${LEAD}', '${CONTATO}', 'stage_changed', 'crm',
            'Movido de Novo para Ganho', '{}'::jsonb)
      on conflict (id) do nothing;
  `);

  // O DELETE do negócio — é ele que dispara o `ON DELETE SET NULL` da 9466.
  sql(`delete from public.crm_leads where id = '${LEAD}';`);
});

/** Quantas linhas de histórico a pessoa vê. */
function visiveisPara(userId: string): number {
  return countAs(
    userId,
    `select count(*) from public.crm_lead_activities where id = '${ATIVIDADE}';`,
  );
}

describe("o histórico do negócio apagado, pela RLS (#4852)", () => {
  it("a linha SOBREVIVE ao negócio, com o contato e sem o lead", () => {
    const out = sql(`
      select (lead_id is null)::text || '|' || contact_id::text
        from public.crm_lead_activities where id = '${ATIVIDADE}';
    `);
    // Sem isto o resto do arquivo mediria uma linha que não existe — e "0
    // visível" passaria por RLS fechada quando é tabela vazia.
    expect(lastLine(out)).toBe(`true|${CONTATO}`);
  });

  it("o GESTOR da empresa lê o histórico do negócio apagado — o M2 do mantenedor", () => {
    // O `[M2] visivel_ao_admin=0` do relatório vira 1.
    expect(visiveisPara(GERENTE)).toBe(1);
    expect(visiveisPara(ADMIN)).toBe(1);
    expect(visiveisPara(VIEWER)).toBe(1);
  });

  it("o AGENTE restrito NÃO lê — o histórico é da empresa, não do funil dele", () => {
    // O dono do negócio apagado continua sem ver a linha órfã: o escopo é
    // `org_wide_read`, e o braço novo não pode abrir o que o `EXISTS` fecha.
    expect(visiveisPara(AGENTE_DONO)).toBe(0);
  });

  it("membro de OUTRA empresa não lê nada", () => {
    expect(visiveisPara(FORASTEIRO)).toBe(0);
  });
});
