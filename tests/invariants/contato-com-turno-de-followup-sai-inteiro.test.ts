import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_MANAGER, GOV_ORG, GOV_SESSION, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * #1862 — excluir um contato que já passou por retorno automático apaga a ficha INTEIRA.
 *
 * O que a issue mediu: `DELETE /api/v1/contacts/:id` de um contato com turno de
 * follow-up em `job_queue` (`kind='followup_turn'`) recusava com `42501` E a
 * auditoria saía com `apagados: ["messages","conversations"]` — o histórico tinha
 * sido apagado antes da recusa. Duas causas:
 *
 *  1. `fn_followup_generation_write` (BEFORE em `job_queue` e
 *     `followup_enrollment_events`) recusa qualquer escrita de quem tem
 *     `auth.uid()`, inclusive o `DELETE` que chega EM CASCATA quando a ficha é
 *     apagada. Conserto (migration 0488): `tg_op='DELETE' and pg_trigger_depth()>1`
 *     → `return old` — só a cascata passa, o `DELETE` direto continua 42501.
 *  2. A rota apagava `messages`, `conversations` e `contacts` em três chamadas.
 *     Conserto: `fn_apagar_contato_com_historico`, `security invoker`, as três
 *     numa transação só.
 *
 * Os três casos abaixo são a régua de sucesso da issue, em Postgres de verdade:
 * ficha inteira some junto (a), `DELETE` direto do turno segue recusado para
 * `auth.uid()` (b) e ficha recusada por outro motivo não leva nada (c).
 * Todos rodam COM A SESSÃO DO USUÁRIO (`set role authenticated` +
 * `request.jwt.claims`), que é o caminho da rota — superusuário não prova nada
 * aqui: para ele a recusa nunca existiu.
 */

/** Diferente do namespace `cccc…` dos invariantes de gov/RLS. */
const N = "dddddddd-0000-4000-8000-000000000";

const CONTATO_A = `${N}011`; // (b) recusa direta do turno
const CONTATO_B = `${N}012`; // (a) ficha inteira
const CONTATO_C = `${N}013`; // (c) compromisso na agenda

const CONV_B = `${N}022`;
const MSG_B = `${N}023`;
const CONV_C = `${N}032`;
const MSG_C = `${N}033`;
const AGENDA = `${N}034`;

const VERSAO = `${N}004`;
const PONTEIRO = `${N}005`;

const ENROLL_A = `${N}016`;
const TURNO_A = `${N}017`;
const EVENTO_A = `${N}018`;

const ENROLL_B = `${N}026`;
const TURNO_B = `${N}027`;
const EVENTO_B = `${N}028`;

const FUNCAO = "fn_apagar_contato_com_historico";

/** Roda um script COM A SESSÃO DO USUÁRIO e devolve o stdout (tuples-only). */
function comoUsuario(userId: string, script: string): string {
  return sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${script}
  `);
}

/**
 * Espera RECUSA: o psql sai com ≠ 0 (ON_ERROR_STOP) e o erro vai para o stderr.
 * Devolve o stderr para a asserção nomear a recusa; se nada falhou, devolve "".
 */
function stderrDe(userId: string, script: string): string {
  try {
    comoUsuario(userId, script);
    return "";
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? "");
  }
}

function contar(porLinha: string): number {
  return Number(lastLine(sql(porLinha)));
}

function semear(): void {
  seedGov();
  sql(`
    -- A ficha que já passou por retorno automático: versão + ponteiro + inscrição,
    -- o turno em job_queue e o evento interno com idempotency_key 'nó:1' — os
    -- DOIS alvos dos gatilhos recusadores da issue.
    insert into public.followup_flow_versions (id, organization_id, graph)
      values ('${VERSAO}', '${GOV_ORG}', '{"nodes":[],"edges":[]}')
      on conflict (id) do nothing;
    insert into public.followup_flow_pointers (id, organization_id, name, status, active_version_id)
      values ('${PONTEIRO}', '${GOV_ORG}', 'retorno-1862', 'active', '${VERSAO}')
      on conflict (id) do nothing;

    -- (b) ficha com turno, para medir a recusa do DELETE direto.
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO_A}', '${GOV_ORG}', 'Contato 1862 A — recusa direta')
      on conflict (id) do nothing;
    insert into public.followup_enrollments
      (id, organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at)
      values ('${ENROLL_A}', '${GOV_ORG}', '${PONTEIRO}', '${VERSAO}', '${CONTATO_A}', 'inicio', 'active', now())
      on conflict (id) do nothing;
    insert into public.followup_enrollment_events
      (id, organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
      values ('${EVENTO_A}', '${GOV_ORG}', '${ENROLL_A}', 'inicio', 'turn_enqueued', '{}', 'inicio:1')
      on conflict (id) do nothing;
    insert into public.job_queue (id, organization_id, contact_id, kind, payload, status)
      values ('${TURNO_A}', '${GOV_ORG}', '${CONTATO_A}', 'followup_turn',
              '{"followup_enrollment_id": "${ENROLL_A}", "node_id": "inicio"}', 'pending')
      on conflict (id) do nothing;

    -- (a) a ficha COMPLETA: mensagem, conversa, inscrição, turno e evento.
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO_B}', '${GOV_ORG}', 'Contato 1862 B — sai inteiro')
      on conflict (id) do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONV_B}', '${GOV_ORG}', '${CONTATO_B}', '${GOV_SESSION}', 'open')
      on conflict (id) do nothing;
    insert into public.messages (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
      values ('${MSG_B}', '${GOV_ORG}', '${CONV_B}', '${GOV_SESSION}', '${CONTATO_B}', 'text', 'inbound', 'historico 1862')
      on conflict (id) do nothing;
    insert into public.followup_enrollments
      (id, organization_id, pointer_id, version_id, contact_id, conversation_id, current_node_id, status, next_eval_at)
      values ('${ENROLL_B}', '${GOV_ORG}', '${PONTEIRO}', '${VERSAO}', '${CONTATO_B}', '${CONV_B}', 'inicio', 'active', now())
      on conflict (id) do nothing;
    insert into public.followup_enrollment_events
      (id, organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
      values ('${EVENTO_B}', '${GOV_ORG}', '${ENROLL_B}', 'inicio', 'turn_enqueued', '{}', 'inicio:1')
      on conflict (id) do nothing;
    insert into public.job_queue (id, organization_id, contact_id, kind, payload, status)
      values ('${TURNO_B}', '${GOV_ORG}', '${CONTATO_B}', 'followup_turn',
              '{"followup_enrollment_id": "${ENROLL_B}", "node_id": "inicio"}', 'pending')
      on conflict (id) do nothing;

    -- (c) ficha com compromisso de agenda (RESTRICT da 0177) — recusa de OUTRO motivo.
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO_C}', '${GOV_ORG}', 'Contato 1862 C — compromisso na agenda')
      on conflict (id) do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONV_C}', '${GOV_ORG}', '${CONTATO_C}', '${GOV_SESSION}', 'open')
      on conflict (id) do nothing;
    insert into public.messages (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
      values ('${MSG_C}', '${GOV_ORG}', '${CONV_C}', '${GOV_SESSION}', '${CONTATO_C}', 'text', 'inbound', 'historico da agenda')
      on conflict (id) do nothing;
    insert into public.calendar_appointments (id, organization_id, contact_id, title, starts_at, ends_at)
      values ('${AGENDA}', '${GOV_ORG}', '${CONTATO_C}', 'Consulta 1862',
              now() + interval '1 day', now() + interval '1 day 1 hour')
      on conflict (id) do nothing;
  `);
}

describe("excluir contato com turno de follow-up (#1862)", () => {
  beforeAll(() => semear());

  it("(b) o DELETE DIRETO do turno de follow-up continua recusado para auth.uid()", () => {
    // A sessão continua sem poder apagar o turno. A ACL agora recusa ANTES
    // do trigger: o SQLSTATE é 42501, com origem distinta da recusa antiga.
    const doTurno = stderrDe(GOV_AGENT_A, `\\set VERBOSITY verbose
delete from public.job_queue where id = '${TURNO_A}';`);
    expect(doTurno).toContain("42501");
    expect(doTurno).toContain("permission denied for table job_queue");

    // O outro alvo: o evento interno (idempotency_key 'nó:1'). Desde a 0490
    // (#1915) a trilha não tem policy de DELETE para a sessão, então a recusa
    // chega ANTES do gatilho: a RLS esconde a linha e o DELETE apaga zero.
    // Medido como contagem explícita — "sem erro" sozinho não prova recusa.
    const apagados = lastLine(
      comoUsuario(
        GOV_AGENT_A,
        `with d as (delete from public.followup_enrollment_events where id = '${EVENTO_A}' returning 1) select count(*) from d;`,
      ),
    );
    expect(apagados).toBe("0");

    // A guarda do gatilho segue viva onde a sessão ainda alcança a trilha: o
    // INSERT de `manager` (a policy deixa, as rotas de intervenção usam). Evento
    // com chave de passo do motor ('nó:N') continua 42501 para `auth.uid()`.
    const passoForjado = stderrDe(
      GOV_MANAGER,
      `insert into public.followup_enrollment_events (organization_id, enrollment_id, node_id, event_type, idempotency_key)
         values ('${GOV_ORG}', '${ENROLL_A}', 'inicio', 'turn_enqueued', 'inicio:2');`,
    );
    expect(passoForjado).toContain("followup_step_internal");
    expect(
      contar(`select count(*) from public.followup_enrollment_events where enrollment_id = '${ENROLL_A}' and idempotency_key = 'inicio:2'`),
    ).toBe(0);

    // Recusado E intacto: nada da ficha saiu com a tentativa.
    expect(contar(`select count(*) from public.job_queue where id = '${TURNO_A}'`)).toBe(1);
    expect(contar(`select count(*) from public.followup_enrollment_events where id = '${EVENTO_A}'`)).toBe(1);
    expect(contar(`select count(*) from public.contacts where id = '${CONTATO_A}'`)).toBe(1);
  });

  it("(a) a rota apaga a ficha INTEIRA — contato, histórico e turno somem juntos", () => {
    // É a mesma chamada que deleteContactHandler faz (uma função, uma transação).
    const fora = lastLine(
      comoUsuario(
        GOV_AGENT_A,
        `select public.${FUNCAO}('${CONTATO_B}', '${GOV_ORG}');`,
      ),
    );
    expect(fora).toBe("t");

    // Ou sai tudo, ou não sai nada: aqui saiu tudo.
    expect(contar(`select count(*) from public.contacts where id = '${CONTATO_B}'`)).toBe(0);
    expect(contar(`select count(*) from public.messages where id = '${MSG_B}'`)).toBe(0);
    expect(contar(`select count(*) from public.conversations where id = '${CONV_B}'`)).toBe(0);
    expect(contar(`select count(*) from public.job_queue where id = '${TURNO_B}'`)).toBe(0);
    expect(contar(`select count(*) from public.followup_enrollments where id = '${ENROLL_B}'`)).toBe(0);
    expect(contar(`select count(*) from public.followup_enrollment_events where id = '${EVENTO_B}'`)).toBe(0);

    // O restante da organização fica de pé: a exclusão é do contato, não do tenant.
    expect(contar(`select count(*) from public.contacts where organization_id = '${GOV_ORG}'`)).toBeGreaterThan(0);
  });

  it("(c) ficha recusada por outro motivo (compromisso na agenda) não leva nada", () => {
    // O RESTRICT de calendar_appointments recusa a ficha; a transação inteira
    // desfaz — o histórico que saiu junto com a recusa era o defeito da #1862.
    const erro = stderrDe(
      GOV_AGENT_A,
      `select public.${FUNCAO}('${CONTATO_C}', '${GOV_ORG}');`,
    );
    expect(erro).toContain("calendar_appointments");

    expect(contar(`select count(*) from public.contacts where id = '${CONTATO_C}'`)).toBe(1);
    expect(contar(`select count(*) from public.messages where id = '${MSG_C}'`)).toBe(1);
    expect(contar(`select count(*) from public.conversations where id = '${CONV_C}'`)).toBe(1);
    expect(contar(`select count(*) from public.calendar_appointments where id = '${AGENDA}'`)).toBe(1);
  });

  it("(a) a função não alcança ficha de outra organização — o filtro é do banco", () => {
    // security invoker não é permissão emprestada: a RLS de quem chama e o
    // p_organization_id fecham a linha nos DOIS lados.
    const fora = lastLine(
      comoUsuario(
        GOV_AGENT_A,
        `select public.${FUNCAO}('${CONTATO_A}', 'eeeeeeee-0000-4000-8000-000000000099');`,
      ),
    );
    expect(fora).toBe("f");
    expect(contar(`select count(*) from public.contacts where id = '${CONTATO_A}'`)).toBe(1);
  });
});
