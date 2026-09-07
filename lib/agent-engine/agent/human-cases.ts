import { currentExecutionBoundary, guardServiceEffect } from "@/lib/atendimento/fronteira-server";
/**
 * Casos humanos (spec 15) — o loop assíncrono IA↔humano quando o agente esbarra
 * num bloqueio que só um humano resolve (aprovar desconto, confirmar política,
 * decidir algo fora do playbook). Duas tools nativas do engine:
 *   - open_human_case: o agente abre um caso (status='awaiting_human') com o
 *     bloqueio explicado — vira item na inbox humana (wiring da Wave 3+).
 *   - provide_case_update: quando o caso está 'awaiting_lead' (humano pediu algo
 *     ao lead) e o lead responde, o agente repassa a info e o caso volta a
 *     'awaiting_human'.
 * As transições disparadas pela RESPOSTA do humano (resolver/pedir info ao
 * lead/escalar) são chamadas pela rota API da Wave 5 — aqui só a mecânica de
 * estado, sempre idempotente.
 *
 * Disciplina (mesma dos irmãos schedule-followup/human-handoff): ids SEMPRE do
 * closure/args confiáveis, nunca do payload do modelo; toda transição é UPDATE
 * condicional (WHERE status = <precondição>) que nunca pisa em estado terminal;
 * UPDATE + INSERT do(s) evento(s) na MESMA transação — aqui via um único
 * statement (WITH ... INSERT ... SELECT FROM <cte>), que é atômico por natureza
 * e dispensa BEGIN/COMMIT explícito, então funciona tanto com pg.Pool quanto
 * com pg.PoolClient (Queryable).
 *
 * `agent_cases.lead_id` é FK para `crm_leads` (o lead do pipeline do CRM) — uma
 * entidade DIFERENTE do `contact_id`/`leadId` usado no resto do agent-engine (ver
 * draft-reply.ts). O espelho de estágio (mirrorLeadStageToCrm) já resolve o
 * negócio do contato para MOVER o card, mas nada aqui lê esse id, então
 * `agent_cases.lead_id` fica NULL sempre — o caso ancora em `conversation_id`
 * (CaseIds não carrega o contact_id: nada aqui o lê).
 */
import { z } from 'zod';
import type pg from 'pg';

import type { Queryable } from '../queue/queue';

export interface CaseIds {
  tenantId: string;
  conversationId: string;
  agentId?: string | null;
}

/**
 * O vocabulário de `agent_case_events.kind`, do lado do TypeScript.
 *
 * Existe para ser comparado com o CHECK do banco em
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts` — é a única classe de
 * divergência que o compilador não enxerga, e o sintoma seria um `23514` num
 * INSERT de caminho pouco exercitado (o registro do agente no chamado é
 * exatamente um desses).
 */
export type CaseEventKind =
  | 'opened'
  | 'human_replied'
  | 'lead_asked'
  | 'lead_provided'
  | 'lead_unresponsive'
  | 'resolved'
  | 'escalated'
  | 'cancelled'
  | 'agent_noted';

/** Whitelist EXATA do payload de open_human_case — mesmo padrão .strict() da F2-10/F3-02. */
export const openHumanCaseInputSchema = z.strictObject({
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(4_000),
  blocker: z.string().min(1).max(1_000),
});
export type OpenHumanCaseInput = z.infer<typeof openHumanCaseInputSchema>;

/** Whitelist EXATA do payload de provide_case_update. */
export const provideCaseUpdateInputSchema = z.strictObject({
  case_id: z.string().uuid(),
  info: z.string().min(1).max(4_000),
});
export type ProvideCaseUpdateInput = z.infer<typeof provideCaseUpdateInputSchema>;

const OPEN_STATUSES = ['awaiting_human', 'awaiting_lead'] as const;

/**
 * True se há um caso 'awaiting_human'|'awaiting_lead' aberto para a conversa.
 * Checa UMA conversa (conversation_id), não o contato inteiro — um contato pode
 * ter >1 conversa por channel_session; o caso pertence a uma conversa.
 */
export async function hasOpenCaseForContact(
  db: Queryable,
  tenantId: string,
  conversationId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ open: boolean }>(
    `select exists (
       select 1 from agent_cases
        where organization_id = $1 and conversation_id = $2
          and status = any($3::text[])
     ) as open`,
    [tenantId, conversationId, OPEN_STATUSES],
  );
  return rows[0]?.open === true;
}

export interface CaseAwaitingLead {
  id: string;
  /** O que o HUMANO pediu ao lead (body do evento need_lead_info mais recente) —
   * NÃO `agent_cases.blocker` (motivo original da IA travar; `markAwaitingLead`
   * nunca o atualiza — usá-lo aqui daria ao modelo a pergunta ERRADA). */
  ask: string;
}

/**
 * O caso 'awaiting_lead' da conversa (humano pediu algo ao lead), se houver.
 * Usado no turno normal (inbound_turn) para dar ao modelo o `case_id` real que
 * `provide_case_update` exige — sem isso o modelo nunca tem como chamar a tool
 * quando o lead simplesmente responde a mensagem (o caminho comum; case_reply_turn
 * só cobre a ação do HUMANO, não a resposta do lead). No máximo 1 por conversa
 * (mesma garantia de `openCase`/dedup).
 */
export async function getCaseAwaitingLead(
  db: Queryable,
  tenantId: string,
  conversationId: string,
): Promise<CaseAwaitingLead | null> {
  const { rows } = await db.query<CaseAwaitingLead>(
    `select c.id, e.body as ask
       from agent_cases c
       join lateral (
         select body from agent_case_events
          where case_id = c.id and kind = 'human_replied' and human_action = 'need_lead_info'
          order by created_at desc
          limit 1
       ) e on true
      where c.organization_id = $1 and c.conversation_id = $2 and c.status = 'awaiting_lead'
      limit 1`,
    [tenantId, conversationId],
  );
  return rows[0] ?? null;
}

export type OpenCaseResult =
  | { ok: true; caseId: string }
  | { ok: false; error: { code: string; message: string } };

/**
 * Abre o caso: INSERT agent_cases(status='awaiting_human') + INSERT
 * agent_case_events(kind='opened') em UM statement atômico. A guarda de dedup
 * (não abrir 2º caso pra mesma conversa) mora no `where not exists` do próprio
 * INSERT — sem essa condição haveria corrida entre a checagem e a escrita;
 * aqui checagem e escrita são a MESMA operação. Essa atomicidade check-and-write
 * vale DENTRO do statement; a garantia de não-duplicação entre transações
 * CONCORRENTES vem da serialização per-contact do job_queue
 * (uniq_job_queue_one_running_per_contact), não deste statement sozinho.
 */
export async function openCase(
  db: pg.Pool,
  ids: CaseIds,
  input: {
    title: string;
    summary: string;
    blocker: string;
    contextSnapshot?: Record<string, unknown>;
    source?: 'agent' | 'guardrail_autofallback';
  },
): Promise<OpenCaseResult> {
  await guardServiceEffect();
  const source = input.source ?? 'agent';
  const actorKind = source === 'agent' ? 'agent' : 'system';

  const { rows } = await db.query<{ case_id: string }>(
    `with new_case as (
       insert into agent_cases
         (organization_id, conversation_id, agent_id, title, summary, blocker, context_snapshot, source)
       select $1, $2, $3, $4, $5, $6, $7::jsonb, $8
        where not exists (
          select 1 from agent_cases
           where organization_id = $1 and conversation_id = $2
             and status = any($9::text[])
        )
       returning id
     )
     insert into agent_case_events (organization_id, case_id, kind, actor_kind)
     select $1, id, 'opened', $10
       from new_case
     returning case_id`,
    [
      ids.tenantId,
      ids.conversationId,
      ids.agentId ?? null,
      input.title,
      input.summary,
      input.blocker,
      JSON.stringify({ ...(input.contextSnapshot ?? {}), ...(currentExecutionBoundary() ? { service_boundary: currentExecutionBoundary() } : {}) }),
      source,
      OPEN_STATUSES,
      actorKind,
    ],
  );

  const caseId = rows[0]?.case_id;
  if (caseId === undefined) {
    return {
      ok: false,
      error: {
        code: 'case_already_open',
        message: 'já existe um caso humano aberto para esta conversa; aguarde a resposta do atendente antes de abrir outro.',
      },
    };
  }
  return { ok: true, caseId };
}

export type ProvideCaseUpdateResult = { ok: true } | { ok: false; error: { code: string; message: string } };

/**
 * awaiting_lead -> awaiting_human (o lead respondeu o que o humano pediu) +
 * evento 'lead_provided' (actor_kind='lead' — a info veio do lead, não do
 * agente nem do humano). De qualquer outro estado é no-op: {ok:false,
 * error.code:'invalid_case_state'}.
 */
export async function provideCaseUpdate(
  db: pg.Pool,
  ids: CaseIds,
  input: { caseId: string; info: string },
): Promise<ProvideCaseUpdateResult> {
  const { rows } = await db.query<{ case_id: string }>(
    `with updated as (
       update agent_cases
          set status = 'awaiting_human', updated_at = now()
        where organization_id = $1 and id = $2 and status = 'awaiting_lead'
        returning id
     )
     insert into agent_case_events (organization_id, case_id, kind, actor_kind, body)
     select $1, id, 'lead_provided', 'lead', $3
       from updated
     returning case_id`,
    [ids.tenantId, input.caseId, input.info],
  );

  if (rows.length === 0) {
    return {
      ok: false,
      error: {
        code: 'invalid_case_state',
        message: 'o caso não está aguardando informação do lead (awaiting_lead); nada foi alterado.',
      },
    };
  }
  return { ok: true };
}

/**
 * As transições abaixo guardam o estado de entrada no próprio `where`, então o
 * statement insere os 2 eventos APENAS quando o update casou. `rowCount` é o
 * número de eventos inseridos: 0 = a corrida foi perdida (outro atendente já
 * respondeu) e nada mudou. Quem chama precisa saber disso para não reportar
 * sucesso de um no-op — daí o boolean em vez de void.
 */
function transitioned(rowCount: number | null): boolean {
  return (rowCount ?? 0) > 0;
}

/**
 * awaiting_human -> resolved (closed_at=now). Dois eventos no mesmo statement:
 * 'human_replied' (human_action='resolved', o registro da AÇÃO do humano) e
 * 'resolved' (o registro da transição do CASO). De qualquer outro estado é
 * no-op — nunca pisa em caso já resolvido/escalado/cancelado.
 */
export async function resolveCaseFromHuman(
  db: Queryable,
  tenantId: string,
  caseId: string,
  actorUserId: string,
  note: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `with updated as (
       update agent_cases
          set status = 'resolved', closed_at = now(), updated_at = now()
        where organization_id = $1 and id = $2 and status = 'awaiting_human'
        returning id
     )
     insert into agent_case_events (organization_id, case_id, kind, actor_kind, actor_user_id, human_action, body)
     select $1::uuid, id, 'human_replied', 'human', $3::uuid, 'resolved', $4::text from updated
     union all
     select $1::uuid, id, 'resolved', 'human', $3::uuid, null::text, null::text from updated`,
    [tenantId, caseId, actorUserId, note],
  );
  return transitioned(rowCount);
}

/**
 * awaiting_human -> awaiting_lead (o humano precisa de mais info do lead).
 * Eventos: 'human_replied' (human_action='need_lead_info') + 'lead_asked'.
 */
export async function markAwaitingLead(
  db: Queryable,
  tenantId: string,
  caseId: string,
  actorUserId: string,
  ask: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `with updated as (
       update agent_cases
          set status = 'awaiting_lead', updated_at = now()
        where organization_id = $1 and id = $2 and status = 'awaiting_human'
        returning id
     )
     insert into agent_case_events (organization_id, case_id, kind, actor_kind, actor_user_id, human_action, body)
     select $1::uuid, id, 'human_replied', 'human', $3::uuid, 'need_lead_info', $4::text from updated
     union all
     select $1::uuid, id, 'lead_asked', 'human', $3::uuid, null::text, null::text from updated`,
    [tenantId, caseId, actorUserId, ask],
  );
  return transitioned(rowCount);
}

/**
 * awaiting_human -> escalated (closed_at=now). Eventos: 'human_replied'
 * (human_action='escalate') + 'escalated'. O handoff humano em si (force_human
 * etc.) é acionado pela ROTA (Wave 5), não aqui — este só fecha o caso.
 */
export async function escalateCase(
  db: Queryable,
  tenantId: string,
  caseId: string,
  actorUserId: string,
  reason: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `with updated as (
       update agent_cases
          set status = 'escalated', closed_at = now(), updated_at = now()
        where organization_id = $1 and id = $2 and status = 'awaiting_human'
        returning id
     )
     insert into agent_case_events (organization_id, case_id, kind, actor_kind, actor_user_id, human_action, body)
     select $1::uuid, id, 'human_replied', 'human', $3::uuid, 'escalate', $4::text from updated
     union all
     select $1::uuid, id, 'escalated', 'human', $3::uuid, null::text, null::text from updated`,
    [tenantId, caseId, actorUserId, reason],
  );
  return transitioned(rowCount);
}

/**
 * O AGENTE registrando o que aconteceu num chamado ABERTO.
 *
 * Ator `agent` e kind `agent_noted` (0100) porque a alternativa seria reusar
 * 'lead_provided'/'human_replied' — e aí a linha do tempo do chamado diria que
 * quem falou foi o lead ou a pessoa. Timeline que mente sobre o autor é pior que
 * timeline curta: ela é OBEDECIDA.
 *
 * A guarda de estado mora no `where exists` do próprio INSERT (mesma disciplina
 * do `openCase`): registrar em chamado já fechado seria escrever história depois
 * do fato, e checar antes num statement separado abriria corrida entre a
 * checagem e a escrita.
 *
 * @returns false quando o chamado não existe, é de outra organização ou já fechou.
 */
export async function registrarNotaDoAgente(
  db: Queryable,
  tenantId: string,
  caseId: string,
  body: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `insert into agent_case_events (organization_id, case_id, kind, actor_kind, body)
     select $1::uuid, c.id, 'agent_noted', 'agent', $3::text
       from agent_cases c
      where c.organization_id = $1 and c.id = $2 and c.status = any($4::text[])`,
    [tenantId, caseId, body, OPEN_STATUSES],
  );
  return transitioned(rowCount);
}

/** Como um chamado pode terminar pela mão do agente. */
export type DesfechoDoChamado = 'resolvido' | 'sem_necessidade';

const STATUS_DO_DESFECHO: Record<DesfechoDoChamado, string> = {
  resolvido: 'resolved',
  sem_necessidade: 'cancelled',
};

const EVENTO_DO_DESFECHO: Record<DesfechoDoChamado, CaseEventKind> = {
  resolvido: 'resolved',
  sem_necessidade: 'cancelled',
};

/**
 * awaiting_human|awaiting_lead -> resolved|cancelled, pela mão do AGENTE.
 *
 * Separado de `resolveCaseFromHuman` de propósito: aquela grava
 * `actor_kind='human'` + `human_action='resolved'`, que é a afirmação de que uma
 * PESSOA decidiu. Chamá-la a partir do agente colocaria uma decisão humana
 * inventada no registro do chamado — e é desse registro que sai o resumo entregue
 * ao próximo atendente.
 *
 * Aceita os DOIS estados abertos (diferente das transições do humano, que só
 * saem de `awaiting_human`): o caso comum é o chamado ficar `awaiting_lead`, o
 * lead resolver sozinho, e ninguém ter como fechar aquilo — chamado imortal na
 * fila de outra pessoa.
 */
export async function encerrarChamadoPeloAgente(
  db: Queryable,
  tenantId: string,
  caseId: string,
  input: { desfecho: DesfechoDoChamado; nota: string },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `with updated as (
       update agent_cases
          set status = $3, closed_at = now(), updated_at = now()
        where organization_id = $1 and id = $2 and status = any($6::text[])
        returning id
     )
     insert into agent_case_events (organization_id, case_id, kind, actor_kind, body)
     select $1::uuid, id, 'agent_noted', 'agent', $5::text from updated
     union all
     select $1::uuid, id, $4::text, 'agent', null::text from updated`,
    [
      tenantId,
      caseId,
      STATUS_DO_DESFECHO[input.desfecho],
      EVENTO_DO_DESFECHO[input.desfecho],
      input.nota,
      OPEN_STATUSES,
    ],
  );
  return transitioned(rowCount);
}

/** Resumo curto do caso para o inbox de escalação (mesmo espírito de buildHandoffSummary). */
export function buildCaseSummary(caseRow: { title: string; summary: string; blocker: string }): string {
  return `${caseRow.title}\n${caseRow.summary}\nBloqueio: ${caseRow.blocker}`;
}
