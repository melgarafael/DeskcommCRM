/**
 * O LEMBRETE AO DONO NO BANCO — migration 9326.
 *
 * Três perguntas que só um Postgres de verdade responde:
 *
 *   · FORMA — a entrega `tipo = 'lembrete'` exige compromisso, degrau e início,
 *     e as formas antigas (aviso e resumo) continuam aceitas com as colunas
 *     novas nulas;
 *   · IDEMPOTÊNCIA — o mesmo degrau do mesmo início para o mesmo destino é
 *     recusado com `23505` (é a chave que o motor lê para não enviar em dobro),
 *     e o início novo de uma remarcação é aceito;
 *   · PORTA — `fn_definir_lembrete_do_aviso_de_agendamento` só aceita o admin
 *     da organização, só muda a linha dela, e não é alcançável pela anon key.
 *
 * Sabotagens previstas: tirar `inicio_lembrado` da chave única deixa vermelho
 * só o caso da remarcação; trocar `'admin'` por `'agent'` na função deixa
 * vermelho só o caso do `agent`; tirar o `revoke ... from public, anon` deixa
 * vermelho só o caso da anon.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG_A = "92280000-0000-4000-8000-000000000001";
const ORG_B = "92280000-0000-4000-8000-000000000002";
const ADMIN_A = "92280000-1111-4000-8000-000000000001";
const ATENDENTE_A = "92280000-1111-4000-8000-000000000002";
const ADMIN_B = "92280000-1111-4000-8000-000000000003";
const SESSAO_A = "92280000-2222-4000-8000-000000000001";
const AG = "92280000-3333-4000-8000-000000000001";
const INICIO = "2026-11-10T17:00:00Z";

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

const lembrete = (degrau: number, inicio: string) =>
  `insert into public.entregas_de_aviso_de_agendamento
     (organization_id, tipo, appointment_id, alvo, destino, channel_session_id, degrau_minutos, inicio_lembrado, status)
   values ('${ORG_A}', 'lembrete', '${AG}', 'numero', '+5519971636881', '${SESSAO_A}', ${degrau}, '${inicio}', 'pendente');`;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN_A}',     'lembrete-9326-admin-a@invariant.test'),
      ('${ATENDENTE_A}', 'lembrete-9326-agent-a@invariant.test'),
      ('${ADMIN_B}',     'lembrete-9326-admin-b@invariant.test')
      on conflict do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'lembrete-9326-a', 'Lembrete 9326 A', 'Lembrete 9326 A'),
      ('${ORG_B}', 'lembrete-9326-b', 'Lembrete 9326 B', 'Lembrete 9326 B')
      on conflict do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ADMIN_A}',     '${ORG_A}', 'admin', now()),
      ('${ATENDENTE_A}', '${ORG_A}', 'agent', now()),
      ('${ADMIN_B}',     '${ORG_B}', 'admin', now())
      on conflict do nothing;

    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_A}', '${ORG_A}', 'lembrete-9326-a', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;

    insert into public.config_aviso_de_caso (organization_id, channel_session_id, telefone_destino, ligado)
      values ('${ORG_A}', '${SESSAO_A}', '+5519971636881', true)
      on conflict (organization_id) do nothing;
    insert into public.config_aviso_de_agendamento (organization_id, usa_numero_do_aviso_de_caso, ligado)
      values ('${ORG_A}', true, true), ('${ORG_B}', true, true)
      on conflict (organization_id) do nothing;

    insert into public.calendar_appointments (id, organization_id, title, starts_at, ends_at, status)
      values ('${AG}', '${ORG_A}', 'Reunião comercial 9326', '${INICIO}', '${INICIO}'::timestamptz + interval '30 min', 'confirmed')
      on conflict (id) do nothing;
  `);
});

describe("9326 — a escolha nasce desligada", () => {
  it("configuração existente ganha `lembrar_antes = false`", () => {
    expect(valor(`select lembrar_antes from public.config_aviso_de_agendamento where organization_id = '${ORG_A}'`)).toMatch(
      /^(f|false)$/,
    );
  });
});

describe("9326 — a forma da entrega", () => {
  it("CONTROLE POSITIVO: o lembrete completo é aceito", () => {
    expect(erroDe(lembrete(1440, INICIO))).toBe("");
  });

  it("lembrete sem degrau ou sem início é recusado", () => {
    expect(
      erroDe(`insert into public.entregas_de_aviso_de_agendamento (organization_id, tipo, appointment_id, destino, inicio_lembrado)
              values ('${ORG_A}', 'lembrete', '${AG}', '+5519971636881', '${INICIO}');`),
    ).toMatch(/forma_check|violates/i);
    expect(
      erroDe(`insert into public.entregas_de_aviso_de_agendamento (organization_id, tipo, appointment_id, destino, degrau_minutos)
              values ('${ORG_A}', 'lembrete', '${AG}', '+5519971636881', 60);`),
    ).toMatch(/forma_check|violates/i);
  });

  it("degrau fora da faixa é recusado", () => {
    expect(erroDe(lembrete(0, INICIO))).toMatch(/degrau_check|violates/i);
  });

  it("o resumo continua aceito, e não aceita degrau", () => {
    expect(
      erroDe(`insert into public.entregas_de_aviso_de_agendamento (organization_id, tipo, dia, destino)
              values ('${ORG_A}', 'resumo', '2026-11-09', '+5519971636881');`),
    ).toBe("");
    expect(
      erroDe(`insert into public.entregas_de_aviso_de_agendamento (organization_id, tipo, dia, destino, degrau_minutos)
              values ('${ORG_A}', 'resumo', '2026-11-08', '+5519971636881', 60);`),
    ).toMatch(/forma_check|violates/i);
  });
});

describe("9326 — sem aviso em dobro, com remarcação", () => {
  it("o mesmo degrau do mesmo início é recusado pela chave única", () => {
    sql(lembrete(60, INICIO));
    expect(erroDe(lembrete(60, INICIO))).toMatch(/lembrete_unico|duplicate key/i);
  });

  it("o mesmo degrau de um início NOVO (remarcação) é aceito", () => {
    expect(erroDe(lembrete(60, "2026-11-12T17:00:00Z"))).toBe("");
  });
});

describe("9326 — a porta de escrita da escolha", () => {
  const definir = (org: string, v: boolean) =>
    `select public.fn_definir_lembrete_do_aviso_de_agendamento('${org}', ${v});`;

  it("CONTROLE POSITIVO: o admin liga, e só a linha da organização dele muda", () => {
    sql(`${comoMembro(ADMIN_A)}\n${definir(ORG_A, true)}`);
    expect(valor(`select lembrar_antes from public.config_aviso_de_agendamento where organization_id = '${ORG_A}'`)).toMatch(
      /^(t|true)$/,
    );
    expect(valor(`select lembrar_antes from public.config_aviso_de_agendamento where organization_id = '${ORG_B}'`)).toMatch(
      /^(f|false)$/,
    );
  });

  it("o admin do vizinho não liga o de A", () => {
    expect(erroDe(`${comoMembro(ADMIN_B)}\n${definir(ORG_A, false)}`)).toMatch(/aviso_de_agendamento_forbidden/i);
  });

  it("`agent` é recusado", () => {
    expect(erroDe(`${comoMembro(ATENDENTE_A)}\n${definir(ORG_A, false)}`)).toMatch(/aviso_de_agendamento_forbidden/i);
  });

  it("a anon key não alcança a função", () => {
    expect(erroDe(`set role anon;\n${definir(ORG_A, false)}`)).toMatch(/permission denied/i);
  });
});
