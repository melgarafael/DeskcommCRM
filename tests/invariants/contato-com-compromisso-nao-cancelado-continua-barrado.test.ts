import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_ORG, GOV_SESSION, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * A OUTRA METADE DA DECISÃO DA 0177 (#4765, achado A9).
 *
 * O conserto do compromisso CANCELADO (PR #4766, migration 9405) abre a exclusão
 * para um caso só: linha `status='cancelled'` e `service_occurrence_id is null`.
 * Tudo o mais continua barrando — marcado (`confirmed`), realizado (`completed`),
 * falta (`no_show`) e reserva de serviço. A decisão da 0177 não mudou, e é este
 * arquivo que a prende no banco de verdade.
 *
 * Por que no banco e não no dublê: o que recusa é a FK `calendar_appointments.
 * contact_id` (`on delete restrict`, 0177) DENTRO da transação da função. Um
 * dublê de PostgREST conta linhas e nunca dispara 23503; um dublê de função não
 * tem FK. O invariante do #4766 exercita `confirmed` (e o caso misto) no banco —
 * `completed`, `no_show` e reserva de serviço só aparecem lá no dublê de
 * `contato-vinculos-dialogo.test.tsx`. Sobrava este vão: nada provava, contra a
 * FK real, que abrir a porta do cancelado não abriu as outras.
 *
 * Com a 9405 na `main`, a função desvincula só o cancelado comum: o UPDATE é
 * filtrado por `status='cancelled'` e `service_occurrence_id is null`, e todo o
 * resto continua preso à FK.
 */

/** Namespace próprio: longe do `cccc…` de gov-helpers e do `dddd…` da #1862. */
const N = "d4765000-0000-4000-8000-000000000";

const CASOS = [
  { chave: "marcado", status: "confirmed", rotulo: "compromisso marcado" },
  { chave: "realizado", status: "completed", rotulo: "compromisso realizado" },
  { chave: "falta", status: "no_show", rotulo: "compromisso com falta" },
] as const;

const CONTATO_SO_CANCELADO = `${N}001`;
const AGENDA_SO_CANCELADO = `${N}002`;
const CONTATO_RESERVA = `${N}011`;
const AGENDA_RESERVA = `${N}012`;
const EVENTO_RESERVA = `${N}013`;
const OCORRENCIA_RESERVA = `${N}014`;
const MSG_SO_CANCELADO = `${N}003`;
const CONV_SO_CANCELADO = `${N}004`;

const FUNCAO = "fn_apagar_contato_com_historico";

/** O recorte que a rota usa para contar o que barra (`barraSe`, `_handler.ts`). */
const BARRA = "(status <> 'cancelled' or service_occurrence_id is not null)";

function comoUsuario(userId: string, script: string): string {
  return sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${script}
  `);
}

/** stderr de uma chamada que precisa FALHAR; string vazia = passou (defeito). */
function erroDe(userId: string, script: string): string {
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

/**
 * O gatilho `fn_calendar_service_appointment_guard` exige, para uma reserva,
 * catálogo de serviço, disponibilidade e ocorrência — semear isso à mão é montar
 * meio produto. A fixture desliga o gatilho SÓ para gravar a linha com a forma
 * que a FK enxerga (contato + reserva cancelada) e o religa antes de qualquer
 * asserção: quem está sob teste é `fn_apagar_contato_com_historico`, não o
 * caminho de criação de reserva (que `tests/invariants/agenda-*` já cobre).
 */
function semear(): void {
  seedGov();

  sql(`
    insert into public.calendar_event_types (id, organization_id, name, slug)
      values ('${EVENTO_RESERVA}', '${GOV_ORG}', 'Serviço A9', 'servico-a9')
      on conflict (id) do nothing;
    insert into public.calendar_service_occurrences
      (id, organization_id, event_type_id, starts_at, ends_at, booking_mode)
      values ('${OCORRENCIA_RESERVA}', '${GOV_ORG}', '${EVENTO_RESERVA}',
              now() + interval '5 days', now() + interval '5 days 30 minutes', 'individual')
      on conflict (id) do nothing;
  `);

  for (const caso of CASOS) {
    const contato = contatoDe(caso.chave);
    const conversa = conversaDe(caso.chave);
    const mensagem = mensagemDe(caso.chave);
    const agenda = agendaDe(caso.chave);
    sql(`
      insert into public.contacts (id, organization_id, display_name)
        values ('${contato}', '${GOV_ORG}', 'Contato A9 ${caso.rotulo}')
        on conflict (id) do nothing;
      insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
        values ('${conversa}', '${GOV_ORG}', '${contato}', '${GOV_SESSION}', 'open')
        on conflict (id) do nothing;
      insert into public.messages
        (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
        values ('${mensagem}', '${GOV_ORG}', '${conversa}', '${GOV_SESSION}', '${contato}', 'text', 'inbound', 'historico A9 ${caso.chave}')
        on conflict (id) do nothing;
      insert into public.calendar_appointments
        (id, organization_id, contact_id, conversation_id, owner_user_id, title,
         starts_at, ends_at, status, cancelled_at)
        values ('${agenda}', '${GOV_ORG}', '${contato}', '${conversa}', '${GOV_AGENT_A}',
                'A9 ${caso.rotulo}', now() + interval '1 day', now() + interval '1 day 1 hour',
                '${caso.status}', null)
        on conflict (id) do nothing;
    `);
  }

  // Contato cujo único compromisso é cancelado e SEM reserva: é o caso que a
  // 9405 resolve, e o contraste do recorte da pré-checagem (caso 5).
  sql(`
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO_SO_CANCELADO}', '${GOV_ORG}', 'Contato A9 só cancelado')
      on conflict (id) do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONV_SO_CANCELADO}', '${GOV_ORG}', '${CONTATO_SO_CANCELADO}', '${GOV_SESSION}', 'open')
      on conflict (id) do nothing;
    insert into public.messages
      (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
      values ('${MSG_SO_CANCELADO}', '${GOV_ORG}', '${CONV_SO_CANCELADO}', '${GOV_SESSION}',
              '${CONTATO_SO_CANCELADO}', 'text', 'inbound', 'historico A9 cancelado')
      on conflict (id) do nothing;
    insert into public.calendar_appointments
      (id, organization_id, contact_id, conversation_id, owner_user_id, title,
       starts_at, ends_at, status, cancelled_at)
      values ('${AGENDA_SO_CANCELADO}', '${GOV_ORG}', '${CONTATO_SO_CANCELADO}', '${CONV_SO_CANCELADO}',
              '${GOV_AGENT_A}', 'A9 cancelado', now() + interval '2 days',
              now() + interval '2 days 1 hour', 'cancelled', now())
      on conflict (id) do nothing;
  `);

  // Reserva de serviço CANCELADA: `status='cancelled'` como qualquer cancelado,
  // mas com `service_occurrence_id` — o recorte da 9405 a deixa de fora.
  sql(`
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO_RESERVA}', '${GOV_ORG}', 'Contato A9 reserva')
      on conflict (id) do nothing;
    alter table public.calendar_appointments disable trigger trg_calendar_service_appointment_guard;
    insert into public.calendar_appointments
      (id, organization_id, contact_id, owner_user_id, title, starts_at, ends_at,
       status, cancelled_at, event_type_id, service_occurrence_id, participant_key,
       service_operation_key)
      values ('${AGENDA_RESERVA}', '${GOV_ORG}', '${CONTATO_RESERVA}', '${GOV_AGENT_A}',
              'A9 reserva cancelada', now() + interval '5 days',
              now() + interval '5 days 30 minutes', 'cancelled', now(),
              '${EVENTO_RESERVA}', '${OCORRENCIA_RESERVA}', '${CONTATO_RESERVA}:primary',
              'a9-reserva')
      on conflict (id) do nothing;
    alter table public.calendar_appointments enable trigger trg_calendar_service_appointment_guard;
  `);
}

function contatoDe(chave: string): string {
  return `${N}${indice(chave)}`;
}
function conversaDe(chave: string): string {
  return `${N}${indice(chave) + 1}`;
}
function mensagemDe(chave: string): string {
  return `${N}${indice(chave) + 2}`;
}
function agendaDe(chave: string): string {
  return `${N}${indice(chave) + 3}`;
}
/** 101/111/121… — sufixo de 3 dígitos distinto por caso. */
function indice(chave: string): number {
  const pos = CASOS.findIndex((c) => c.chave === chave);
  return 101 + pos * 10;
}

describe("compromisso não cancelado e reserva de serviço continuam barrando a exclusão (A9, 0177)", () => {
  beforeAll(() => semear());

  for (const caso of CASOS) {
    it(`${caso.rotulo} (${caso.status}) recusa a exclusão e não apaga nada`, () => {
      const contato = contatoDe(caso.chave);
      const agenda = agendaDe(caso.chave);
      const mensagem = mensagemDe(caso.chave);

      const erro = erroDe(GOV_AGENT_A, `select public.${FUNCAO}('${contato}', '${GOV_ORG}');`);

      // A recusa tem de vir da FK da 0177, nomeada: erro de outra origem (42501
      // de RLS, por exemplo) não prova que o VÍNCULO barrou. (O psql não ecoa o
      // SQLSTATE por padrão; o nome da constraint é mais estável que o número.)
      expect(erro).toContain("calendar_appointments_contact_id_fkey");

      // A transação inteira volta: ficha, histórico e vínculo como estavam.
      expect(contar(`select count(*) from public.contacts where id = '${contato}'`)).toBe(1);
      expect(contar(`select count(*) from public.messages where id = '${mensagem}'`)).toBe(1);
      expect(
        lastLine(
          sql(`select concat_ws('|', status, contact_id::text)
                 from public.calendar_appointments where id = '${agenda}'`),
        ),
      ).toBe(`${caso.status}|${contato}`);
    });
  }

  it("reserva de serviço cancelada continua barrando a exclusão", () => {
    const erro = erroDe(GOV_AGENT_A, `select public.${FUNCAO}('${CONTATO_RESERVA}', '${GOV_ORG}');`);

    // Aqui a recusa pode vir do gatilho da reserva (42501 `service_writer_required`)
    // ou da FK (23503): as duas barram e nenhuma apaga. O que NÃO pode acontecer é
    // a chamada passar — reserva de serviço não é compromisso cancelado comum.
    expect(erro).toMatch(/calendar_appointments_contact_id_fkey|service_writer_required/);

    expect(contar(`select count(*) from public.contacts where id = '${CONTATO_RESERVA}'`)).toBe(1);
    expect(
      lastLine(
        sql(`select concat_ws('|', status, coalesce(contact_id::text, 'null'),
                              coalesce(service_occurrence_id::text, 'null'))
               from public.calendar_appointments where id = '${AGENDA_RESERVA}'`),
      ),
    ).toBe(`cancelled|${CONTATO_RESERVA}|${OCORRENCIA_RESERVA}`);
  });

  it("a pré-checagem conta exatamente os quatro que a função não resolve, e não o cancelado comum", () => {
    const comuns = CASOS.map((c) => `'${contatoDe(c.chave)}'`).join(", ");
    const contados = contar(`select count(*) from public.calendar_appointments
                              where contact_id in (${comuns}) and organization_id = '${GOV_ORG}'
                                and ${BARRA}`);
    expect(contados).toBe(3);

    // Reserva de serviço (cancelada) entra na conta.
    expect(
      contar(`select count(*) from public.calendar_appointments
               where contact_id = '${CONTATO_RESERVA}' and organization_id = '${GOV_ORG}'
                 and ${BARRA}`),
    ).toBe(1);

    // Cancelado comum não entra: é ele que a 9405 desvincula.
    expect(
      contar(`select count(*) from public.calendar_appointments
               where contact_id = '${CONTATO_SO_CANCELADO}' and organization_id = '${GOV_ORG}'
                 and ${BARRA}`),
    ).toBe(0);
  });
});
