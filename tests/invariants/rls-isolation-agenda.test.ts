import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Task 18 (agenda nativa) — RLS isolation invariant para as 3 tabelas da
 * migration 0165 (`appointment_types`, `attendant_schedule`, `appointments`).
 *
 * Roda contra o Postgres efêmero subido por `scripts/test-db.sh` (baseline.sql
 * já aplicado — `pnpm test:db`). Semeia 2 orgs + 1 usuário cada, e prova que um
 * usuário da org A lê ZERO linhas da org B nas 3 tabelas, sob RLS, simulando o
 * JWT via `set_config('request.jwt.claims', ...)` — o mesmo caminho
 * `auth.uid()` / `fn_user_org_ids()` / `fn_can_view_lead()` que as policies de
 * produção usam (ver `supabase/migrations/20260830120000_0165_agenda_nativa.sql`).
 *
 * A segunda metade do arquivo prova a exclusion constraint de `appointments`
 * (`exclude using gist (responsible_user_id with =, tstzrange(...) with &&)
 * where (status = 'scheduled')`) — ver a nota sobre prova sequencial vs.
 * concorrente no comentário daquele teste.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — run this suite via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

/** Roda um script SQL em UMA sessão psql dentro do container; devolve stdout (tuples-only). */
function sql(script: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      containerName,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      "-f",
      "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

// UUIDs fixos deixam o seed idempotente (on conflict do nothing).
const ORG_A = "aaaaaaaa-0000-4000-8000-000a9e17d001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000a9e17d002";
const USER_A = "aaaaaaaa-1111-4000-8000-000a9e17d001";
const USER_B = "bbbbbbbb-1111-4000-8000-000a9e17d002";

/**
 * Roda SELECTs como o role `authenticated` com o JWT do usuário dado, do mesmo
 * jeito que PostgREST/Supabase fazem: role de sessão + request.jwt.claims.
 */
function countAs(userId: string, countQuery: string): number {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${countQuery}
  `);
  const lines = out.split("\n");
  const last = lines[lines.length - 1];
  if (last === undefined || !/^\d+$/.test(last)) {
    throw new Error(`unexpected psql output: ${out}`);
  }
  return Number(last);
}

function seedOrg(org: string, user: string, tag: string): string {
  // Sem PII real: e-mails/nomes sintéticos apenas (LGPD).
  return `
    insert into auth.users (id, email) values ('${user}', 'rls-agenda-${tag}@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', 'rls-agenda-inv-${tag}', 'RLS Agenda Invariant ${tag}', 'RLS Agenda ${tag}')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${user}', '${org}', 'admin', now())
      on conflict do nothing;
  `;
}

beforeAll(() => {
  sql(seedOrg(ORG_A, USER_A, "a") + seedOrg(ORG_B, USER_B, "b"));
  // pipeline -> stage -> contact -> lead -> appointment_type -> attendant_schedule -> appointment, por org.
  sql(`
    do $seed$
    declare
      v_org uuid;
      v_user uuid;
      v_pipe uuid;
      v_stage uuid;
      v_contact uuid;
      v_lead uuid;
      v_type uuid;
    begin
      for v_org, v_user in
        select * from (values
          ('${ORG_A}'::uuid, '${USER_A}'::uuid),
          ('${ORG_B}'::uuid, '${USER_B}'::uuid)
        ) as t(org, usr)
      loop
        select id into v_pipe from public.crm_pipelines
          where organization_id = v_org and slug = 'rls-agenda-inv';
        if v_pipe is null then
          insert into public.crm_pipelines (organization_id, name, slug)
            values (v_org, 'RLS Agenda Invariant', 'rls-agenda-inv') returning id into v_pipe;
        end if;

        select id into v_stage from public.crm_stages
          where organization_id = v_org and pipeline_id = v_pipe and slug = 'novo';
        if v_stage is null then
          insert into public.crm_stages (organization_id, pipeline_id, name, slug, position)
            values (v_org, v_pipe, 'Novo', 'novo', 1000) returning id into v_stage;
        end if;

        select id into v_contact from public.contacts
          where organization_id = v_org and display_name = 'RLS Agenda Invariant Contact';
        if v_contact is null then
          insert into public.contacts (organization_id, display_name)
            values (v_org, 'RLS Agenda Invariant Contact') returning id into v_contact;
        end if;

        if not exists (select 1 from public.crm_leads where organization_id = v_org and title = 'RLS agenda invariant lead') then
          insert into public.crm_leads (organization_id, pipeline_id, stage_id, contact_id, title, owner_user_id)
            values (v_org, v_pipe, v_stage, v_contact, 'RLS agenda invariant lead', v_user)
            returning id into v_lead;
        else
          select id into v_lead from public.crm_leads
            where organization_id = v_org and title = 'RLS agenda invariant lead';
        end if;

        if not exists (select 1 from public.appointment_types where organization_id = v_org) then
          insert into public.appointment_types (organization_id, name, duration_minutes, responsible_user_id)
            values (v_org, 'Consulta', 30, v_user) returning id into v_type;
        else
          select id into v_type from public.appointment_types where organization_id = v_org limit 1;
        end if;

        if not exists (select 1 from public.attendant_schedule where organization_id = v_org) then
          insert into public.attendant_schedule (organization_id, user_id, day_of_week, starts_at, ends_at)
            values (v_org, v_user, 1, '09:00', '17:00');
        end if;

        if not exists (select 1 from public.appointments where organization_id = v_org) then
          insert into public.appointments
            (organization_id, lead_id, appointment_type_id, responsible_user_id, scheduled_at, duration_minutes, created_by_user_id)
            values (v_org, v_lead, v_type, v_user, now() + interval '2 days', 30, v_user);
        end if;
      end loop;
    end
    $seed$;
  `);
});

/**
 * ⚠️ LISTA FIXA — as 3 tabelas de `20260830120000_0165_agenda_nativa.sql`.
 * `appointments` NÃO filtra por `organization_id` na policy SELECT (ela herda
 * a visibilidade do lead via `fn_can_view_lead`) — por isso a query de
 * contagem cross-tenant abaixo usa `organization_id = ORG_B` mesmo assim: o
 * WHERE ainda restringe as linhas candidatas, e a policy tem que zerar o
 * resultado independente de como a visibilidade é decidida por baixo.
 */
const TABLES = ["appointment_types", "attendant_schedule", "appointments"] as const;

describe("RLS — appointment_types/attendant_schedule/appointments isolam por organização", () => {
  for (const table of TABLES) {
    it(`usuário da org A não vê ${table} da org B`, () => {
      const crossTenant = countAs(
        USER_A,
        `select count(*) from public.${table} where organization_id = '${ORG_B}';`,
      );
      expect(crossTenant).toBe(0);
    });

    it(`usuário da org A ainda vê ${table} da própria org (controle positivo)`, () => {
      const ownRows = countAs(
        USER_A,
        `select count(*) from public.${table} where organization_id = '${ORG_A}';`,
      );
      expect(ownRows).toBeGreaterThanOrEqual(1);
    });
  }

  it("superusuário vê as 2 orgs (sanidade do seed: as linhas cross-tenant existem de verdade)", () => {
    const total = Number(
      sql(
        `select count(distinct organization_id) from public.appointments where organization_id in ('${ORG_A}','${ORG_B}');`,
      ),
    );
    expect(total).toBe(2);
  });

  /**
   * A exclusion constraint (`exclude using gist (responsible_user_id with =,
   * tstzrange(scheduled_at, scheduled_at + duration) with &&) where (status =
   * 'scheduled')`) é uma regra do banco pensada pra segurar CONCORRÊNCIA: duas
   * requisições paralelas tentando reservar o mesmo horário do mesmo
   * responsável. A prova "correta" abriria 2 conexões psql simultâneas
   * (`Promise.all` ao redor de 2 `execFileSync` cada uma na sua própria
   * transação, com `pg_sleep` calibrado pra colidir no meio do INSERT) — mas
   * isso não roda nem se depura sem um Postgres real na frente, e esta sessão
   * não tem Docker disponível pra iterar até acertar o timing.
   *
   * Por isso este teste faz a prova mais FRACA que a nota do brief autoriza
   * como fallback: SEQUENCIAL, na MESMA sessão. Insere um agendamento
   * `scheduled`, depois tenta inserir um segundo, sobreposto (mesmo
   * `responsible_user_id`, mesmo intervalo de tempo), na mesma transação
   * implícita da sessão, e confirma que o Postgres recusa com SQLSTATE
   * `23P01` (`exclusion_violation`). Isso prova que a constraint EXISTE e
   * dispara nas condições certas — não prova que ela seja atômica sob
   * corrida real (2 INSERTs que colidem exatamente no meio da checagem do
   * índice GiST). A garantia de atomicidade sob concorrência vem do próprio
   * mecanismo `EXCLUDE USING gist` do Postgres (é como ele impede duas
   * transações concorrentes de commitarem violações uma da outra — mesmo
   * princípio de uma unique constraint), não deste teste.
   */
  it("a exclusion constraint recusa 2 agendamentos scheduled sobrepostos para o mesmo responsável (prova sequencial, não concorrente)", () => {
    const out = sql(`
      do $$
      declare
        v_org uuid := gen_random_uuid();
        v_user uuid := gen_random_uuid();
        v_pipe uuid := gen_random_uuid();
        v_stage uuid := gen_random_uuid();
        v_contact uuid := gen_random_uuid();
        v_lead uuid := gen_random_uuid();
        v_type uuid := gen_random_uuid();
        v_start timestamptz := now() + interval '3 days';
        v_state text := 'no_error';
      begin
        insert into organizations (id, slug, legal_name, display_name)
          values (v_org, 'rls-agenda-exclusion-inv', 'X', 'X');
        insert into auth.users (id, email) values (v_user, 'rls-agenda-exclusion@invariant.test');
        insert into contacts (id, organization_id, display_name) values (v_contact, v_org, 'C');
        insert into crm_pipelines (id, organization_id, name, slug)
          values (v_pipe, v_org, 'Pipeline Exclusion', 'pipeline-exclusion-inv');
        insert into crm_stages (id, organization_id, pipeline_id, name, slug, position)
          values (v_stage, v_org, v_pipe, 'Novo', 'novo', 1000);
        insert into crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title)
          values (v_lead, v_org, v_pipe, v_stage, v_contact, 'Lead exclusion');
        insert into appointment_types (id, organization_id, name, duration_minutes, responsible_user_id)
          values (v_type, v_org, 'Consulta', 60, v_user);

        -- Primeiro agendamento: scheduled, 60min a partir de v_start. Tem que
        -- entrar sem erro.
        insert into appointments
          (organization_id, lead_id, appointment_type_id, responsible_user_id, scheduled_at, duration_minutes, created_by_user_id)
          values (v_org, v_lead, v_type, v_user, v_start, 60, v_user);

        -- Segundo agendamento: mesmo responsável, começa 30min depois do
        -- primeiro (ainda dentro da janela de 60min dele) -> intervalos se
        -- sobrepõem -> a exclusion constraint tem que recusar.
        begin
          insert into appointments
            (organization_id, lead_id, appointment_type_id, responsible_user_id, scheduled_at, duration_minutes, created_by_user_id)
            values (v_org, v_lead, v_type, v_user, v_start + interval '30 minutes', 60, v_user);
          v_state := 'no_error';
        exception when exclusion_violation then
          v_state := sqlstate;
        end;

        perform set_config('test.exclusion_result', v_state, false);
      end $$;

      select current_setting('test.exclusion_result');
    `);
    // `psql -tA` suprime cabeçalho/rodapé de SELECT, mas não a tag de conclusão
    // do `DO $$ ... $$;` ("DO", numa linha própria antes do resultado do SELECT
    // seguinte) — por isso a última linha, não o texto inteiro, é o resultado.
    const linhas = out.trim().split("\n");
    expect(linhas[linhas.length - 1]).toBe("23P01");
  });
});
