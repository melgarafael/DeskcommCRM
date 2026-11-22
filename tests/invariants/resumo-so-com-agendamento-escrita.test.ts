/**
 * O RESUMO SÓ EM DIA COM AGENDAMENTO NO BANCO — migration 9434 (#4988).
 *
 * Duas perguntas que só um Postgres de verdade responde:
 *
 *   · PADRÃO — a configuração que já existia ganha a coluna DESLIGADA: quem
 *     recebia o resumo todo dia continua recebendo depois de atualizar;
 *   · PORTA — `fn_definir_resumo_do_aviso_de_agendamento` só aceita o admin
 *     da organização, só muda a linha dela, recusa quem ainda não tem
 *     configuração, e não é alcançável pela anon key.
 *
 * Sabotagens previstas: `default true` na coluna deixa vermelho só o caso do
 * padrão; trocar `'admin'` por `'agent'` na função deixa vermelho só o caso do
 * `agent`; tirar o `where organization_id = p_org` do UPDATE deixa vermelho o
 * controle positivo (a linha de B muda junto); tirar o `revoke ... from
 * public, anon` deixa vermelho só o caso da anon.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG_A = "94340000-0000-4000-8000-000000000001";
const ORG_B = "94340000-0000-4000-8000-000000000002";
const ORG_SEM_CONFIG = "94340000-0000-4000-8000-000000000003";
const ADMIN_A = "94340000-1111-4000-8000-000000000001";
const ATENDENTE_A = "94340000-1111-4000-8000-000000000002";
const ADMIN_B = "94340000-1111-4000-8000-000000000003";
const ADMIN_SEM_CONFIG = "94340000-1111-4000-8000-000000000004";
const SESSAO_A = "94340000-2222-4000-8000-000000000001";

function comoMembro(userId: string): string {
  return `set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);`;
}

function erroDe(comando: string): string {
  try {
    sql(comando);
    return "";
  } catch (e) {
    return motivoDoErro(e);
  }
}

function valor(consulta: string): string {
  return (sql(consulta).trim().split("\n").at(-1) ?? "").trim();
}

const escolhaDe = (org: string) =>
  valor(`select resumo_so_com_agendamento from public.config_aviso_de_agendamento where organization_id = '${org}'`);

const definir = (org: string, v: boolean) =>
  `select public.fn_definir_resumo_do_aviso_de_agendamento('${org}', ${v});`;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN_A}',          'resumo-9434-admin-a@invariant.test'),
      ('${ATENDENTE_A}',      'resumo-9434-agent-a@invariant.test'),
      ('${ADMIN_B}',          'resumo-9434-admin-b@invariant.test'),
      ('${ADMIN_SEM_CONFIG}', 'resumo-9434-admin-c@invariant.test')
      on conflict do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}',          'resumo-9434-a', 'Resumo 9434 A', 'Resumo 9434 A'),
      ('${ORG_B}',          'resumo-9434-b', 'Resumo 9434 B', 'Resumo 9434 B'),
      ('${ORG_SEM_CONFIG}', 'resumo-9434-c', 'Resumo 9434 C', 'Resumo 9434 C')
      on conflict do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ADMIN_A}',          '${ORG_A}',          'admin', now()),
      ('${ATENDENTE_A}',      '${ORG_A}',          'agent', now()),
      ('${ADMIN_B}',          '${ORG_B}',          'admin', now()),
      ('${ADMIN_SEM_CONFIG}', '${ORG_SEM_CONFIG}', 'admin', now())
      on conflict do nothing;

    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_A}', '${ORG_A}', 'resumo-9434-a', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;

    insert into public.config_aviso_de_caso (organization_id, channel_session_id, telefone_destino, ligado)
      values ('${ORG_A}', '${SESSAO_A}', '+5519971636882', true)
      on conflict (organization_id) do nothing;
    insert into public.config_aviso_de_agendamento (organization_id, usa_numero_do_aviso_de_caso, ligado)
      values ('${ORG_A}', true, true), ('${ORG_B}', true, true)
      on conflict (organization_id) do nothing;
  `);
});

describe("9434 — a escolha nasce desligada", () => {
  it("configuração existente ganha `resumo_so_com_agendamento = false`", () => {
    expect(escolhaDe(ORG_A)).toMatch(/^(f|false)$/);
    expect(escolhaDe(ORG_B)).toMatch(/^(f|false)$/);
  });
});

describe("9434 — a porta de escrita da escolha", () => {
  it("CONTROLE POSITIVO: o admin liga, e só a linha da organização dele muda", () => {
    expect(valor(`${comoMembro(ADMIN_A)}\n${definir(ORG_A, true)}`)).toMatch(/^(f|false)$/);
    expect(escolhaDe(ORG_A)).toMatch(/^(t|true)$/);
    expect(escolhaDe(ORG_B)).toMatch(/^(f|false)$/);
  });

  it("devolve a escolha de ANTES, para a auditoria", () => {
    expect(valor(`${comoMembro(ADMIN_A)}\n${definir(ORG_A, true)}`)).toMatch(/^(t|true)$/);
  });

  it("o admin do vizinho não mexe na de A", () => {
    expect(erroDe(`${comoMembro(ADMIN_B)}\n${definir(ORG_A, false)}`)).toMatch(/aviso_de_agendamento_forbidden/i);
    expect(escolhaDe(ORG_A)).toMatch(/^(t|true)$/);
  });

  it("`agent` é recusado", () => {
    expect(erroDe(`${comoMembro(ATENDENTE_A)}\n${definir(ORG_A, false)}`)).toMatch(/aviso_de_agendamento_forbidden/i);
  });

  it("sem configuração salva, a escolha é recusada (não cria linha pela metade)", () => {
    expect(erroDe(`${comoMembro(ADMIN_SEM_CONFIG)}\n${definir(ORG_SEM_CONFIG, true)}`)).toMatch(
      /aviso_de_agendamento_sem_config/i,
    );
    expect(
      valor(`select count(*) from public.config_aviso_de_agendamento where organization_id = '${ORG_SEM_CONFIG}'`),
    ).toBe("0");
  });

  it("a anon key não alcança a função", () => {
    expect(erroDe(`set role anon;\n${definir(ORG_A, false)}`)).toMatch(/permission denied/i);
  });
});
