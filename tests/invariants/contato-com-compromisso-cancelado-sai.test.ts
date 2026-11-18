import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_ORG, GOV_SESSION, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * Achado A9 (`curso/ACHADOS.md`), migration 9405 — compromisso CANCELADO não
 * impede excluir o contato.
 *
 * O defeito: a pré-checagem da rota contava toda linha de `calendar_appointments`
 * do contato, e a FK `contact_id` (RESTRICT, 0177) recusava a ficha mesmo sem
 * ela. O DELETE da Agenda é cancelamento, então quem teve um compromisso
 * cancelado nunca saía da base. `fn_apagar_contato_com_historico` agora
 * desvincula o cancelado (contact_id e conversation_id a NULL) antes de apagar o
 * histórico; o vivo continua barrando.
 *
 * Tudo roda COM A SESSÃO DO USUÁRIO (`set role authenticated` +
 * `request.jwt.claims`), que é o caminho da rota: o UPDATE do desvínculo passa
 * pela RLS de `calendar_appointments` e pelos gatilhos de quem tem `auth.uid()`.
 */

/** Namespace próprio, longe do `cccc…` de gov/RLS e do `dddd…` da #1862. */
const N = "d9405000-0000-4000-8000-000000000";

const CONTATO_SO_CANCELADO = `${N}011`;
const CONV_SO_CANCELADO = `${N}012`;
const MSG_SO_CANCELADO = `${N}013`;
const AGENDA_CANCELADA = `${N}014`;

const CONTATO_MISTO = `${N}021`;
const AGENDA_MISTO_CANCELADA = `${N}022`;
const AGENDA_MISTO_VIVA = `${N}023`;

const FUNCAO = "fn_apagar_contato_com_historico";

/**
 * O recorte que a rota usa para contar o que barra (`barraSe` em
 * `app/api/v1/contacts/_handler.ts`), escrito em SQL. Se a função passar a
 * desvincular outra coisa, este predicado e o da rota mudam juntos.
 */
const BARRA = "(status <> 'cancelled' or service_occurrence_id is not null)";

function comoUsuario(userId: string, script: string): string {
  return sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${script}
  `);
}

function stderrDe(userId: string, script: string): string {
  try {
    comoUsuario(userId, script);
    return "";
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? "");
  }
}

function contar(consulta: string): number {
  return Number(lastLine(sql(consulta)));
}

function semear(): void {
  seedGov();
  sql(`
    -- Contato cujo único compromisso foi CANCELADO, com conversa e mensagem.
    -- O compromisso aponta para a conversa: é o caso que exige zerar
    -- conversation_id junto (fn_appointment_stamp recusa conversa de outro contato).
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO_SO_CANCELADO}', '${GOV_ORG}', 'Contato A9 — só cancelado')
      on conflict (id) do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONV_SO_CANCELADO}', '${GOV_ORG}', '${CONTATO_SO_CANCELADO}', '${GOV_SESSION}', 'open')
      on conflict (id) do nothing;
    insert into public.messages (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
      values ('${MSG_SO_CANCELADO}', '${GOV_ORG}', '${CONV_SO_CANCELADO}', '${GOV_SESSION}', '${CONTATO_SO_CANCELADO}', 'text', 'inbound', 'historico A9')
      on conflict (id) do nothing;
    insert into public.calendar_appointments
      (id, organization_id, contact_id, conversation_id, owner_user_id, title, starts_at, ends_at, status, cancelled_at)
      values ('${AGENDA_CANCELADA}', '${GOV_ORG}', '${CONTATO_SO_CANCELADO}', '${CONV_SO_CANCELADO}', '${GOV_AGENT_A}',
              'Consulta A9 cancelada', now() + interval '1 day', now() + interval '1 day 1 hour', 'cancelled', now())
      on conflict (id) do nothing;

    -- Contato com um cancelado E um vivo: o vivo barra, e a recusa desfaz o
    -- desvínculo do cancelado (uma transação só).
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO_MISTO}', '${GOV_ORG}', 'Contato A9 — cancelado e vivo')
      on conflict (id) do nothing;
    insert into public.calendar_appointments
      (id, organization_id, contact_id, owner_user_id, title, starts_at, ends_at, status, cancelled_at)
      values ('${AGENDA_MISTO_CANCELADA}', '${GOV_ORG}', '${CONTATO_MISTO}', '${GOV_AGENT_A}',
              'Consulta A9 misto cancelada', now() + interval '2 days', now() + interval '2 days 1 hour', 'cancelled', now())
      on conflict (id) do nothing;
    insert into public.calendar_appointments
      (id, organization_id, contact_id, owner_user_id, title, starts_at, ends_at, status)
      values ('${AGENDA_MISTO_VIVA}', '${GOV_ORG}', '${CONTATO_MISTO}', '${GOV_AGENT_A}',
              'Consulta A9 misto viva', now() + interval '3 days', now() + interval '3 days 1 hour', 'confirmed')
      on conflict (id) do nothing;
  `);
}

describe("compromisso cancelado não impede excluir o contato (A9, migration 9405)", () => {
  beforeAll(() => semear());

  it("a pré-checagem e a função dizem a mesma coisa: só o vivo barra", () => {
    expect(
      contar(`select count(*) from public.calendar_appointments
               where contact_id = '${CONTATO_SO_CANCELADO}' and organization_id = '${GOV_ORG}' and ${BARRA}`),
    ).toBe(0);
    expect(
      contar(`select count(*) from public.calendar_appointments
               where contact_id = '${CONTATO_MISTO}' and organization_id = '${GOV_ORG}' and ${BARRA}`),
    ).toBe(1);
  });

  it("contato só com compromisso cancelado sai inteiro, e o compromisso fica na agenda sem ele", () => {
    const fora = lastLine(
      comoUsuario(GOV_AGENT_A, `select public.${FUNCAO}('${CONTATO_SO_CANCELADO}', '${GOV_ORG}');`),
    );
    expect(fora).toBe("t");

    expect(contar(`select count(*) from public.contacts where id = '${CONTATO_SO_CANCELADO}'`)).toBe(0);
    expect(contar(`select count(*) from public.messages where id = '${MSG_SO_CANCELADO}'`)).toBe(0);
    expect(contar(`select count(*) from public.conversations where id = '${CONV_SO_CANCELADO}'`)).toBe(0);

    // A linha continua na agenda de quem atendeu: desvinculada, ainda cancelada.
    expect(
      lastLine(
        sql(`select concat_ws('|', status, coalesce(contact_id::text, 'null'), coalesce(conversation_id::text, 'null'), title)
               from public.calendar_appointments where id = '${AGENDA_CANCELADA}'`),
      ),
    ).toBe("cancelled|null|null|Consulta A9 cancelada");
  });

  it("compromisso vivo continua barrando, e a recusa desfaz o desvínculo do cancelado", () => {
    const erro = stderrDe(GOV_AGENT_A, `select public.${FUNCAO}('${CONTATO_MISTO}', '${GOV_ORG}');`);
    expect(erro).toContain("calendar_appointments");

    expect(contar(`select count(*) from public.contacts where id = '${CONTATO_MISTO}'`)).toBe(1);
    // Os dois compromissos seguem ligados à ficha: nada saiu pela metade.
    expect(
      contar(`select count(*) from public.calendar_appointments
               where contact_id = '${CONTATO_MISTO}'
                 and id in ('${AGENDA_MISTO_CANCELADA}', '${AGENDA_MISTO_VIVA}')`),
    ).toBe(2);
  });
});
