import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * RELATÓRIO DE ATIVIDADES — o relatório de uma organização NUNCA conta a
 * atividade de outra.
 *
 * ## Por que uma pessoa de UMA organização não é o caso interessante
 *
 * `fn_activity_report` é SECURITY INVOKER: a policy `crm_lead_activities_select`
 * já recorta o que a sessão enxerga. Para quem pertence a UMA organização, a
 * RLS sozinha zera qualquer `p_org` forjado — o filtro `organization_id = p_org`
 * dentro da função não teria trabalho nenhum, e apagá-lo passaria despercebido.
 *
 * O caso que mede o filtro é a pessoa que pertence a DUAS (`user_organizations`
 * é N:N, e prestador de serviço com duas contas é o normal do produto): a RLS
 * abre as duas organizações para ela, e a ÚNICA coisa que decide qual delas o
 * relatório soma é o `p_org` — resolvido do cookie na rota, jamais do body.
 * Sem esse filtro, "o que a equipe fez esta semana" na organização A viria com
 * o trabalho da organização B dentro, sem erro nenhum na tela.
 *
 * Por isso este arquivo semeia DUAS pessoas: uma de uma organização só (prova
 * que a RLS fecha) e uma das duas (prova que o filtro explícito fecha). Medido
 * por sabotagem: removendo `and a.organization_id = p_org` do corpo da função,
 * os casos de contagem, de tipo, de ator e de lista vermelham.
 *
 * ## E a promoção a SECURITY DEFINER
 *
 * Um `definer` "para simplificar" trocaria o recorte da RLS por uma checagem
 * paralela que pode divergir dela — e passaria a ver as duas organizações
 * SEMPRE, com o `p_org` como única defesa. O primeiro caso guarda isso.
 */

const ORG_A = "d0d0d0d0-0000-4000-8000-000000000001";
const ORG_B = "d0d0d0d0-0000-4000-8000-000000000002";
/** Pertence só à A — mede a RLS. */
const USER_SO_A = "d0d0d0d0-1111-4000-8000-000000000001";
/** Pertence às DUAS — mede o filtro explícito por `p_org`. */
const USER_MULTI = "d0d0d0d0-1111-4000-8000-000000000002";

const PIPE_A = "d0d0d0d0-5555-4000-8000-000000000001";
const PIPE_B = "d0d0d0d0-5555-4000-8000-000000000002";
const STAGE_A = "d0d0d0d0-5555-4000-8000-000000000011";
const STAGE_B = "d0d0d0d0-5555-4000-8000-000000000012";
const LEAD_A = "d0d0d0d0-6666-4000-8000-000000000001";
const LEAD_B = "d0d0d0d0-6666-4000-8000-000000000002";

/** Tipos REAIS do vocabulário (`lib/leads/activity-vocabulary.ts`), um por org. */
const TIPO_A = "note";
const TIPO_B = "lead_edited";

/** Quantidades diferentes de propósito: 3 + 5 = 8, e 8 não é nem 3 nem 5. */
const ATIVIDADES_A = 3;
const ATIVIDADES_B = 5;

function semearOrg(
  org: string,
  tag: string,
  pipe: string,
  stage: string,
  lead: string,
  tipo: string,
  quantas: number,
  ator: string,
): string {
  return `
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', 'rel-ativ-${tag}', 'Relatorio Invariante ${tag}', 'Rel ${tag}')
      on conflict (id) do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${pipe}', '${org}', 'Relatorio Invariante', 'rel-ativ')
      on conflict (id) do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${stage}', '${org}', '${pipe}', 'Novo', 'novo', 1000)
      on conflict (id) do nothing;
    -- owner_user_id NULL + papel manager: fn_can_view_lead devolve true por
    -- papel, então o que este arquivo mede é tenancy, não visibilidade por dono.
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title)
      values ('${lead}', '${org}', '${pipe}', '${stage}', 'Negocio do invariante ${tag}')
      on conflict (id) do nothing;
    insert into public.crm_lead_activities
      (id, organization_id, lead_id, type, source_module, actor_kind, performed_by_user_id, performed_at)
    select
      ('d0d0d0d0-7777-4000-8000-${tag}0000000000' || i::text)::uuid,
      '${org}', '${lead}', '${tipo}', 'invariante', 'user', '${ator}',
      now() - interval '1 hour'
    from generate_series(1, ${quantas}) as g(i)
    on conflict (id) do nothing;
  `;
}

/** Chama a função como `authenticated` com as claims da pessoa, e devolve o jsonb. */
function relatorioComo(userId: string, org: string): {
  total: number;
  tipos: string[];
  atores: string[];
  leads: string[];
} {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    select public.fn_activity_report(
      '${org}'::uuid,
      now() - interval '1 day',
      now() + interval '1 minute',
      'UTC',
      500
    )::text;
  `);
  const linhas = out.split("\n");
  const bruto = linhas[linhas.length - 1];
  if (bruto === undefined) throw new Error(`saída vazia do psql: ${out}`);
  const r = JSON.parse(bruto) as {
    total: number;
    by_type: Array<{ type: string }>;
    by_actor: Array<{ user_id: string | null }>;
    items: Array<{ lead_id: string | null }>;
  };
  return {
    total: r.total,
    tipos: r.by_type.map((t) => t.type),
    atores: r.by_actor.map((a) => a.user_id ?? "-"),
    leads: [...new Set(r.items.map((i) => i.lead_id ?? "-"))],
  };
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${USER_SO_A}', 'rel-ativ-so-a@invariant.test'),
      ('${USER_MULTI}', 'rel-ativ-multi@invariant.test')
      on conflict (id) do nothing;
  `);
  sql(
    semearOrg(ORG_A, "a", PIPE_A, STAGE_A, LEAD_A, TIPO_A, ATIVIDADES_A, USER_SO_A) +
      semearOrg(ORG_B, "b", PIPE_B, STAGE_B, LEAD_B, TIPO_B, ATIVIDADES_B, USER_MULTI),
  );
  sql(`
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_SO_A}', '${ORG_A}', 'manager', now()),
      ('${USER_MULTI}', '${ORG_A}', 'manager', now()),
      ('${USER_MULTI}', '${ORG_B}', 'manager', now())
      on conflict do nothing;
  `);
});

describe("relatório de atividades — a função", () => {
  it("existe e é SECURITY INVOKER (o escopo é a RLS, não uma checagem paralela)", () => {
    const linha = sql(`
      select p.prosecdef
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'fn_activity_report';
    `);
    expect(linha).toBe("f");
  });

  it("não é alcançável pela anon key, e é alcançável por quem tem sessão", () => {
    const anon = sql(
      `select has_function_privilege('anon', 'public.fn_activity_report(uuid,timestamptz,timestamptz,text,int)', 'EXECUTE');`,
    );
    const auth = sql(
      `select has_function_privilege('authenticated', 'public.fn_activity_report(uuid,timestamptz,timestamptz,text,int)', 'EXECUTE');`,
    );
    expect(anon).toBe("f");
    expect(auth).toBe("t");
  });

  it("tem o índice do recorte por período (senão o relatório varre a org inteira)", () => {
    const existe = sql(
      `select exists(select 1 from pg_indexes where schemaname='public' and indexname='idx_lead_activities_org_perf');`,
    );
    expect(existe).toBe("t");
  });
});

describe("relatório de atividades — isolamento entre organizações", () => {
  it("a pessoa das DUAS organizações recebe o total da que pediu, nunca a soma", () => {
    expect(relatorioComo(USER_MULTI, ORG_A).total).toBe(ATIVIDADES_A);
    expect(relatorioComo(USER_MULTI, ORG_B).total).toBe(ATIVIDADES_B);
  });

  it("o que foi feito na B não aparece em 'o que foi feito' da A", () => {
    const a = relatorioComo(USER_MULTI, ORG_A);
    expect(a.tipos).toContain(TIPO_A);
    expect(a.tipos).not.toContain(TIPO_B);
  });

  it("quem trabalhou na B não aparece em 'quem fez' da A", () => {
    const a = relatorioComo(USER_MULTI, ORG_A);
    expect(a.atores).toContain(USER_SO_A);
    expect(a.atores).not.toContain(USER_MULTI);
  });

  it("a lista da A não traz nenhum negócio da B", () => {
    const a = relatorioComo(USER_MULTI, ORG_A);
    expect(a.leads).toEqual([LEAD_A]);
  });

  it("quem não é da B pede a B e recebe zero — e não recebe a A no lugar", () => {
    const b = relatorioComo(USER_SO_A, ORG_B);
    expect(b.total).toBe(0);
    expect(b.leads).toEqual([]);
  });
});
