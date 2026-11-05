import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_LEAD,
  GOV_MANAGER,
  GOV_ORG,
  GOV_PIPELINE,
  GOV_STAGE,
  lastLine,
  seedGov,
  sql,
} from "./gov-helpers";

/**
 * O push da ETAPA QUE AVISA leva o valor a quem PODE VER o negócio — e a mais
 * ninguém (migration 9210, issue #3981).
 *
 * A régua é a da RLS de `crm_leads` (`fn_can_view_lead`), não uma cópia: os
 * casos abaixo são os mesmos de `gov-5c-lead-scope.test.ts`, agora do lado do
 * envio. O que estava errado antes não era a régua, era o CRITÉRIO da audiência
 * do valor: `visibility_mode = 'all'` — o modo da organização — em vez de "esta
 * pessoa vê este negócio". Numa carteira fechada, o gerente nunca recebia valor.
 *
 * GOV_ORG está no default `own_and_unassigned`. O negócio do AGENTE B é dele;
 * o sem dono é de todos no modo padrão.
 */

const REVOGADO = "3981a0a0-1111-4000-8000-000000000001";
const OUTRA_ORG = "3981a0a0-0000-4000-8000-000000000001";
const LEAD_DO_B = "3981a0a0-6666-4000-8000-000000000001";
const LEAD_DE_OUTRA_ORG = "3981a0a0-6666-4000-8000-000000000002";
const LEAD_INEXISTENTE = "3981a0a0-6666-4000-8000-0000000000ff";

const SUB = {
  a: "https://push.invariant.test/3981-agente-a",
  b: "https://push.invariant.test/3981-agente-b",
  manager: "https://push.invariant.test/3981-manager",
  revogado: "https://push.invariant.test/3981-revogado",
};

/**
 * As inscrições de quem vê o negócio, como `endpoint:ampla` — o `ampla` é o que
 * decide se a pessoa recebe a soma do dia (gestão) ou só o valor (carteira).
 */
function inscricoesQueVeem(org: string, lead: string): string[] {
  const out = sql(
    `select coalesce(string_agg(endpoint || ':' || ampla, ',' order by endpoint), '')
       from public.fn_push_inscricoes_que_veem_o_negocio('${org}', '${lead}');`,
  );
  const linha = lastLine(out);
  return linha ? linha.split(",") : [];
}

/** Só os endpoints, para o caso em que a largura não importa. */
function quemRecebe(org: string, lead: string): string[] {
  return inscricoesQueVeem(org, lead).map((l) => l.replace(/:(true|false)$/, ""));
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into auth.users (id, email) values ('${REVOGADO}', 'push-3981-revogado@invariant.test') on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at, revoked_at)
      values ('${REVOGADO}', '${GOV_ORG}', 'manager', now(), now()) on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${OUTRA_ORG}', 'push-3981-outra', 'Push 3981 Outra Org', 'Push 3981 Outra') on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('3981a0a0-5555-4000-8000-000000000001', '${OUTRA_ORG}', 'Outra', 'outra-3981') on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('3981a0a0-5555-4000-8000-000000000002', '${OUTRA_ORG}', '3981a0a0-5555-4000-8000-000000000001', 'Novo', 'novo-3981', 1000) on conflict do nothing;
    insert into public.push_subscriptions (organization_id, user_id, endpoint, p256dh, auth) values
      ('${GOV_ORG}', '${GOV_AGENT_A}', '${SUB.a}', 'k', 'a'),
      ('${GOV_ORG}', '${GOV_AGENT_B}', '${SUB.b}', 'k', 'a'),
      ('${GOV_ORG}', '${GOV_MANAGER}', '${SUB.manager}', 'k', 'a'),
      ('${GOV_ORG}', '${REVOGADO}', '${SUB.revogado}', 'k', 'a')
    on conflict (endpoint) do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id)
      values ('${LEAD_DO_B}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Negócio do agente B', '${GOV_AGENT_B}')
    on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title)
      values ('${LEAD_DE_OUTRA_ORG}', '${OUTRA_ORG}', '3981a0a0-5555-4000-8000-000000000001', '3981a0a0-5555-4000-8000-000000000002', 'Negócio de outra org')
    on conflict do nothing;
  `);
});

describe("push da etapa: só as inscrições de quem pode ver o negócio", () => {
  it("negócio do agent B em own_and_unassigned: B e o gerente; o agent A não", () => {
    expect(quemRecebe(GOV_ORG, LEAD_DO_B).sort()).toEqual([SUB.b, SUB.manager].sort());
  });

  it("o `ampla` separa a gestão de quem vê só a carteira — é ele que libera a soma do dia", () => {
    expect(inscricoesQueVeem(GOV_ORG, LEAD_DO_B).sort()).toEqual(
      [`${SUB.b}:false`, `${SUB.manager}:true`].sort(),
    );
  });

  it("negócio sem dono em own_and_unassigned: os dois agentes e o gerente; vínculo revogado nunca", () => {
    expect(quemRecebe(GOV_ORG, GOV_LEAD).sort()).toEqual([SUB.a, SUB.b, SUB.manager].sort());
  });

  it("negócio de OUTRA organização: ninguém", () => {
    expect(inscricoesQueVeem(OUTRA_ORG, LEAD_DO_B)).toEqual([]);
    expect(inscricoesQueVeem(GOV_ORG, LEAD_DE_OUTRA_ORG)).toEqual([]);
  });

  it("negócio inexistente: ninguém", () => {
    expect(inscricoesQueVeem(GOV_ORG, LEAD_INEXISTENTE)).toEqual([]);
  });

  // Na MESMA transação, como o PostgREST chama: fora dela o set_config local
  // já se desfaria sozinho e o caso passaria sem medir nada. Sem `commit` de
  // propósito: o psql imprimiria "COMMIT" como última linha. O laço da função
  // segue `order by user_id`: o último inscrito é o gerente, nunca o agent A
  // que chama aqui — sem restaurar, as claims sairiam com o sub do gerente.
  it("devolve as claims de quem chamou intactas", () => {
    const out = sql(`
      begin;
      select set_config('request.jwt.claims', '{"sub":"${GOV_AGENT_A}"}', true);
      select count(*) from public.fn_push_inscricoes_que_veem_o_negocio('${GOV_ORG}', '${LEAD_DO_B}');
      select current_setting('request.jwt.claims') || '|' || auth.uid()::text;
    `);
    expect(lastLine(out)).toBe(`{"sub":"${GOV_AGENT_A}"}|${GOV_AGENT_A}`);
  });

  it("só o service role executa", () => {
    const out = sql(`
      select string_agg(r, ',' order by r) from unnest(array['anon','authenticated','service_role']) r
       where has_function_privilege(r, 'public.fn_push_inscricoes_que_veem_o_negocio(uuid, uuid)', 'execute');
    `);
    expect(lastLine(out)).toBe("service_role");
  });

  // Daqui para baixo muda o visibility_mode do GOV_ORG (cada arquivo tem banco
  // próprio); os casos rodam em ordem.
  it("em 'own': o negócio do B chega ao B e ao gerente; o agent A fica de fora", () => {
    definirModo("own");
    expect(quemRecebe(GOV_ORG, LEAD_DO_B).sort()).toEqual([SUB.b, SUB.manager].sort());
  });

  it("em 'all': os dois agentes e o gerente — o modo 'all' continua como era", () => {
    definirModo("all");
    expect(quemRecebe(GOV_ORG, LEAD_DO_B).sort()).toEqual([SUB.a, SUB.b, SUB.manager].sort());
  });
});

function definirModo(modo: "own" | "all"): void {
  sql(`update public.organizations set settings = coalesce(settings, '{}'::jsonb) || '{"visibility_mode":"${modo}"}'
        where id = '${GOV_ORG}';`);
}
