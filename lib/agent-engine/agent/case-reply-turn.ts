/**
 * Handler do job `case_reply_turn` (spec 15 §4.3) — o "loop de follow-up de
 * cabeça pra baixo": em vez do TEMPO reinjetar um turno (`followup_turn`), é a
 * RESPOSTA DO HUMANO a um caso aberto que reinjeta. Molde: `followup-turn.ts`.
 * A intenção aqui é DETERMINÍSTICA (veio do botão do humano na UI, Wave 5) —
 * o agente só redige/repassa, nunca reinterpreta a ação.
 *
 * Só as ações `resolved` e `need_lead_info` produzem re-entrada do agente.
 * `escalate` dispara `performHumanHandoff` direto na rota (Wave 5) e nunca
 * chega aqui. Reusa runAgentTurn por inteiro; a única diferença de
 * followup_turn é a abertura (bloco de re-entrada do caso, no sufixo) e a
 * resolução da conversa: pelo CASE (conversation_id), não pelo contato.
 *
 * Ids de envio (conversa + número) vêm da ROW real do caso/conversa (mesmo
 * banco), NUNCA do payload do modelo — o payload do humano só carrega
 * case_id/action/body, e o próprio case_id é validado contra organization_id
 * do job.
 */
import { z } from 'zod';
import type pg from 'pg';

import { withFields } from '../obs/logger';
import type { JobRow } from '../queue/queue';
import type { LeadContext } from '../edge/crm/get-lead-context';
import { ritualBlocks, runAgentTurn, type InboundTurnDeps, type LeadCheckpointRow } from './inbound-turn';
import type { LeadStateRow } from './lead-state';

/**
 * Payload enfileirado pela rota humana (Wave 5) ao agir sobre um caso.
 * `action` é `z.string()` (não enum) DE PROPÓSITO — uma action fora do escopo
 * de re-entrada (ex.: um valor inesperado por bug de outra camada) deve virar
 * no-op defensivo aqui, não um job morto por falha de parse. `.passthrough()`
 * tolerante, mesmo padrão de `followupTurnPayloadSchema`.
 */
export const caseReplyTurnPayloadSchema = z
  .object({
    case_id: z.string().uuid(),
    action: z.string(),
    body: z.string().optional(),
  })
  .passthrough();
export type CaseReplyTurnPayload = z.infer<typeof caseReplyTurnPayloadSchema>;

/** Ações que geram re-entrada do agente — `escalate` não passa por aqui (Wave 5). */
const REENTRY_ACTIONS = ['resolved', 'need_lead_info'] as const;
type ReentryAction = (typeof REENTRY_ACTIONS)[number];

function isReentryAction(action: string): action is ReentryAction {
  return (REENTRY_ACTIONS as readonly string[]).includes(action);
}

/**
 * Status ESPERADO do caso pra cada ação de re-entrada — a rota (Wave 5) faz a
 * transição + o enqueue no MESMO commit, então quando este job roda o caso JÁ
 * está no status pós-transição, não mais em `awaiting_human`. `resolved` é
 * status TERMINAL de propósito (o humano concluiu); checar contra
 * "ainda aberto" (como antes) descartava TODO envio de conclusão ao lead —
 * bug real da Wave 7, achado na prova E2E. Um status diferente do esperado
 * pra aquela action é sinal genuíno de corrida/anomalia → no-op defensivo.
 */
const EXPECTED_STATUS_FOR_ACTION: Record<ReentryAction, string> = {
  resolved: 'resolved',
  need_lead_info: 'awaiting_lead',
};

interface CaseConversationRow {
  conversationId: string;
  channelSessionId: string;
}

/**
 * Resolve a conversa DO CASO (não a mais recente do contato — o followup_turn
 * faz isso, mas um caso já sabe qual é a sua conversa). Retorna null quando o
 * caso não existe, está num status diferente do esperado pra esta `action`
 * (ver `EXPECTED_STATUS_FOR_ACTION`) ou a conversa não tem número associado —
 * todos os casos são NO-OP, nunca crash.
 */
async function resolveCaseConversation(
  pool: pg.Pool,
  tenantId: string,
  caseId: string,
  action: ReentryAction,
): Promise<CaseConversationRow | null> {
  const { rows } = await pool.query<{ status: string; conversation_id: string; channel_session_id: string | null }>(
    `select ac.status, ac.conversation_id, conv.channel_session_id
       from agent_cases ac
       join conversations conv
         on conv.id = ac.conversation_id and conv.organization_id = ac.organization_id
      where ac.organization_id = $1 and ac.id = $2`,
    [tenantId, caseId],
  );
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  if (row.status !== EXPECTED_STATUS_FOR_ACTION[action] || row.channel_session_id === null) {
    return null;
  }
  return { conversationId: row.conversation_id, channelSessionId: row.channel_session_id };
}

/**
 * Abertura da re-entrada do caso: instrução determinística do responsável
 * (não interpretação do modelo) no topo do sufixo + o ritual padrão. Exportada
 * PURA para teste — igual a `buildFollowupOpeningMessage`.
 */
export function buildCaseReplyOpeningMessage(
  action: ReentryAction,
  caseId: string,
  body: string | undefined,
  previous: LeadCheckpointRow | null,
  leadState: LeadStateRow | null,
  context: LeadContext,
  notesIndexBlock: string,
  projeta = false,
  oferecidas?: readonly string[],
): string {
  const caseIdShort = caseId.slice(0, 8);
  const note = body?.trim() ?? '';
  const oferece = (nome: string): boolean =>
    oferecidas === undefined || oferecidas.includes(nome);
  const instructionBlock =
    action === 'resolved'
      ? `O responsável concluiu o caso #${caseIdShort} com a nota: "${note}". Repasse essa conclusão ao lead de forma natural e encerre o assunto.`
      : `Para avançar no caso #${caseIdShort}, o responsável interno precisa que você obtenha do cliente: "${note}". ` +
        `Pergunte ao lead de forma natural. Assim que tiver a resposta, chame a tool provide_case_update com case_id "${caseId}".`;
  return [
    'Resposta do responsável interno sobre um caso que você abriu.',
    '',
    '## Instrução do responsável sobre o caso',
    instructionBlock,
    '',
    ...ritualBlocks(previous, leadState, context, notesIndexBlock, projeta),
    '',
    'Repasse ao lead usando a tool send_message — NUNCA escreva a resposta como texto direto',
    '(texto fora de tool é descartado pelo runtime).' +
      (oferece('get_lead_context')
        ? ' Use get_lead_context se precisar reler o contexto.'
        : ''),
    ...(oferece('update_lead_state')
      ? [
          'Houve avanço REAL no funil neste turno? Marque-o com update_lead_state (só o próximo estágio válido).',
        ]
      : []),
    ...(oferece('save_lead_note')
      ? [
          'Aprendeu algo durável sobre o lead? Salve com save_lead_note (a headline entra no índice de memória).',
        ]
      : []),
  ].join('\n');
}

/**
 * Handler de `case_reply_turn` para o registry do daemon (main.ts). Resolve a
 * conversa pelo CASE (fonte confiável), no-opa em caso terminal/inexistente ou
 * action fora do escopo de re-entrada, e delega a runAgentTurn (mesmo núcleo
 * do inbound_turn/followup_turn).
 */
export function createCaseReplyTurnHandler(deps: InboundTurnDeps) {
  return async (job: JobRow, pool: pg.Pool, ctx: { workerId: string }): Promise<void> => {
    const tenantId = job.organization_id;
    const leadId = job.contact_id;
    if (leadId === null) {
      throw new Error('job case_reply_turn sem contact_id — o CHECK da fila deveria impedir');
    }
    const payload = caseReplyTurnPayloadSchema.parse(job.payload);
    const runLog = withFields(deps.log, { job_id: job.id, tenant_id: tenantId, lead_id: leadId, case_id: payload.case_id });

    if (!isReentryAction(payload.action)) {
      runLog.info('case_reply_turn no-op — action fora do escopo de re-entrada do agente', { action: payload.action });
      return;
    }
    const action: ReentryAction = payload.action;

    const caseConversation = await resolveCaseConversation(pool, tenantId, payload.case_id, action);
    if (caseConversation === null) {
      runLog.info('case_reply_turn no-op — caso inexistente, terminal ou sem número associado', {
        action: payload.action,
      });
      return;
    }

    await runAgentTurn(deps, job, pool, ctx, {
      channelSessionId: caseConversation.channelSessionId,
      conversationId: caseConversation.conversationId,
      buildOpening: ({ previous, leadState, context, notesIndexBlock, projeta, oferecidas }) =>
        buildCaseReplyOpeningMessage(action, payload.case_id, payload.body, previous, leadState, context, notesIndexBlock, projeta, oferecidas),
    });
  };
}
