import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * A AGENDA ACEITA UMA AUTORIDADE DE FORA (migration 9392, #4227 etapa 1 de 2).
 *
 * Contra o banco real com o `baseline.sql` aplicado. Cada sonda roda num
 * `begin … rollback` com as próprias fixtures, então nenhuma depende de outra.
 *
 * O que cada grupo fixa, e o CONTROLE de cada um (sem ele o verde não prova):
 *
 *   - a linha que ninguém marcou como externa nasce `'local'` — é o estado de
 *     toda instalação que não usa integração;
 *   - a identidade externa (authority, external_*) é do SERVIDOR: a sessão não
 *     a cria nem a muda. Controle: a mesma sessão continua editando o resto da
 *     linha, local ou externa — a guarda não pode ter virado uma tranca geral;
 *   - compromisso externo não entra na fila do Google; o local, com os mesmos
 *     dados, entra;
 *   - o servidor espelha `completed` vindo de fora sem confirmação humana e sem
 *     certificar o desfecho. Controle: no compromisso LOCAL o servidor segue
 *     recusado com `appointment_human_confirmation_required`, como antes.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

const ORG = "aaaaaaaa-9392-4000-8000-000000000001";
const ADMIN = "aaaaaaaa-9392-4000-8000-000000000002";
const CONEXAO = "aaaaaaaa-9392-4000-8000-000000000003";
const LOCAL = "aaaaaaaa-9392-4000-8000-000000000011";
const EXTERNO = "aaaaaaaa-9392-4000-8000-000000000012";
const PROVEDOR = "sistema_da_clinica";

const FIXTURES = `
insert into auth.users (id, email) values ('${ADMIN}', 'admin-9392@deskcomm.test');
insert into public.organizations (id, slug, display_name, legal_name) values ('${ORG}', 'org-9392', 'Org 9392', 'Org 9392');
insert into public.user_organizations (user_id, organization_id, role, accepted_at) values ('${ADMIN}', '${ORG}', 'admin', now());
insert into public.calendar_appointments (id, organization_id, owner_user_id, title, starts_at, ends_at, time_zone, status)
  values ('${LOCAL}', '${ORG}', '${ADMIN}', 'local', now() - interval '4 hours', now() - interval '3 hours', 'America/Sao_Paulo', 'confirmed');
insert into public.calendar_appointments (id, organization_id, owner_user_id, title, starts_at, ends_at, time_zone, status, authority, external_connection_id, external_status)
  values ('${EXTERNO}', '${ORG}', '${ADMIN}', 'externo', now() - interval '2 hours', now() - interval '1 hour', 'America/Sao_Paulo', 'confirmed', '${PROVEDOR}', '${CONEXAO}', 'agendado');
`;

/** Roda `corpo` depois das fixtures, numa transação desfeita; devolve a última linha. */
function sonda(corpo: string, fixtures = FIXTURES): string {
  const saida = execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qtA", "-f", "-"],
    { input: `begin;\n${fixtures}\n${corpo}\nrollback;`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
  return saida.split("\n").at(-1) ?? "";
}

const comoSessao = (sql: string) =>
  `set local role authenticated; select set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);\n${sql}`;
const comoServidor = (sql: string) => `set local role service_role;\n${sql}`;

/** Exige que `sql` falhe com ESTA mensagem — 42501 também é o erro de RLS, e o código sozinho não separa os dois. */
const recusa = (sql: string, mensagem: string) => `
do $s$ begin
  begin ${sql};
  exception when others then
    if sqlerrm = '${mensagem}' then return; end if;
    raise exception 'esperava %, veio % (%)', '${mensagem}', sqlerrm, sqlstate;
  end;
  raise exception 'esperava %, e passou', '${mensagem}';
end $s$;
select 'recusado';`;

describe("compromisso sem integração", () => {
  it("nasce local, sem identidade externa", () => {
    expect(
      sonda(`select authority = 'local' and external_connection_id is null and external_status is null
               from public.calendar_appointments where id = '${LOCAL}';`),
    ).toBe("t");
  });

  it("autoridade e conexão andam juntas (constraint de coerência)", () => {
    expect(
      sonda(recusa(`update public.calendar_appointments set external_connection_id = '${CONEXAO}' where id = '${LOCAL}'`,
        'new row for relation "calendar_appointments" violates check constraint "calendar_appointments_autoridade_coerente"')),
    ).toBe("recusado");
    expect(
      sonda(recusa(`update public.calendar_appointments set external_connection_id = null where id = '${EXTERNO}'`,
        'new row for relation "calendar_appointments" violates check constraint "calendar_appointments_autoridade_coerente"')),
    ).toBe("recusado");
  });
});

describe("a identidade externa é do servidor", () => {
  it("a sessão não cria compromisso externo", () => {
    expect(
      sonda(comoSessao(recusa(
        `insert into public.calendar_appointments (organization_id, owner_user_id, title, starts_at, ends_at, time_zone, status, authority, external_connection_id)
         values ('${ORG}', '${ADMIN}', 'forjado', now() + interval '1 day', now() + interval '1 day 1 hour', 'America/Sao_Paulo', 'confirmed', '${PROVEDOR}', '${CONEXAO}')`,
        "agenda_autoridade_reservada"))),
    ).toBe("recusado");
  });

  it("a sessão não troca a autoridade de nenhum dos dois lados", () => {
    expect(
      sonda(comoSessao(recusa(
        `update public.calendar_appointments set authority = '${PROVEDOR}', external_connection_id = '${CONEXAO}' where id = '${LOCAL}'`,
        "agenda_autoridade_reservada"))),
    ).toBe("recusado");
    expect(
      sonda(comoSessao(recusa(
        `update public.calendar_appointments set external_status = 'cancelado' where id = '${EXTERNO}'`,
        "agenda_autoridade_reservada"))),
    ).toBe("recusado");
  });

  it("controle: a sessão segue editando o resto da linha, local e externa", () => {
    expect(
      sonda(comoSessao(`
        update public.calendar_appointments set notes = 'trazer exames' where id in ('${LOCAL}', '${EXTERNO}');
        select count(*) from public.calendar_appointments where notes = 'trazer exames';`)),
    ).toBe("2");
  });

  it("o servidor cria e atualiza a identidade externa", () => {
    expect(
      sonda(comoServidor(`
        update public.calendar_appointments set external_status = 'confirmado' where id = '${EXTERNO}';
        select external_status from public.calendar_appointments where id = '${EXTERNO}';`)),
    ).toBe("confirmado");
  });

  it("tipo de atendimento: a sessão não cria tipo externo; o servidor cria, e a identidade é única", () => {
    const tipo = (slug: string) =>
      `insert into public.calendar_event_types (organization_id, name, slug, external_provider, external_id, external_connection_id)
       values ('${ORG}', 'Retorno', '${slug}', '${PROVEDOR}', '42', '${CONEXAO}')`;
    expect(sonda(comoSessao(recusa(tipo("retorno-sessao"), "agenda_origem_do_tipo_reservada")))).toBe("recusado");
    expect(sonda(comoServidor(`${tipo("retorno-a")}; select count(*) from public.calendar_event_types where external_id = '42';`))).toBe("1");
    expect(
      sonda(comoServidor(`${tipo("retorno-a")}; ${recusa(tipo("retorno-b"),
        'duplicate key value violates unique constraint "calendar_event_types_external_identity_uq"')}`)),
    ).toBe("recusado");
  });

  it("controle: a sessão segue criando tipo local", () => {
    expect(
      sonda(comoSessao(`
        insert into public.calendar_event_types (organization_id, name, slug) values ('${ORG}', 'Avaliação', 'avaliacao-9392');
        select count(*) from public.calendar_event_types where slug = 'avaliacao-9392' and external_provider is null;`)),
    ).toBe("1");
  });
});

describe("Google", () => {
  it("a fila do push leva o local e deixa o externo de fora", () => {
    expect(
      sonda(`select string_agg(title, ',' order by title) from public.calendar_service_google_push_queue q
               join public.calendar_appointments a on a.id = q.id where q.organization_id = '${ORG}';`),
    ).toBe("local");
  });
});

describe("desfecho vindo de fora", () => {
  it("o servidor espelha `completed` no externo, sem certificar", () => {
    expect(
      sonda(comoServidor(`
        update public.calendar_appointments set status = 'completed' where id = '${EXTERNO}';
        select status = 'completed' and outcome_source_kind is null and outcome_user_id is null and outcome_recorded_at is null
          from public.calendar_appointments where id = '${EXTERNO}';`)),
    ).toBe("t");
  });

  it("controle: no local o servidor continua sem poder registrar desfecho", () => {
    expect(
      sonda(comoServidor(recusa(
        `update public.calendar_appointments set status = 'completed' where id = '${LOCAL}'`,
        "appointment_human_confirmation_required"))),
    ).toBe("recusado");
  });
});

describe("migration", () => {
  const migration = readFileSync("supabase/migrations/20261115133922_9392_agenda_autoridade_externa.sql", "utf8");

  it("reaplica sem erro (idempotente) e o baseline traz o mesmo corpo", () => {
    // Sem fixtures: inserir compromisso deixa evento de gatilho pendente na
    // transação, e o Postgres recusa `alter table` com evento pendente.
    expect(sonda(`${migration}\n${migration}\nselect 'ok';`, "")).toBe("ok");
    const corpo = migration.slice(migration.indexOf("-- ═══ As colunas ═══"));
    expect(readFileSync("supabase/baseline.sql", "utf8")).toContain(corpo);
  });
});
