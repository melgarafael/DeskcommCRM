import { assertAgentOperationPg } from '@/lib/ai/agents/operation';
import type { AgentOperationContext } from '@/lib/ai/agents/operation';
import { assertApprovedReplyPg, type ApprovedReplyContext } from '@/lib/ai/replies/delivery';
import { assertMeetingDeliveryPg, type MeetingDeliveryContext } from '@/lib/agenda/meet-delivery';
import type { JobClaim } from '../../queue/claim';
import { assertAgendaEffectPg } from '@/lib/agenda/efeito';
import { AgendaDeferredError } from '@/lib/agenda/protecao-followup';
import { StaleServiceBoundaryError } from '@/lib/atendimento/fronteira';
import { requireCurrentServiceBoundary } from '@/lib/atendimento/fronteira-server';
import { parseServiceBoundary } from '@/lib/atendimento/fronteira';
/**
 * Borda de saída pós-fusão: envio de mensagem SEMPRE via `sendMessageHandler` do
 * próprio app (app/api/v1/messages/_handler.ts) — o handler insere a linha
 * outbound, envia pelo WAHA, atualiza conversa, audita e emite evento; e dá de
 * graça o guard is_blocked (ApiError 403). A tool `send_message` do agente chama
 * ESTA função depois da cadeia de guardrails; nenhum output de modelo vira
 * mensagem sem passar por aqui.
 *
 * Idempotência (o handler NÃO tem idempotency key própria — o ledger cobre):
 *   1. transação lógica: insert em `send_ledger` (unique (job_id, seq)); o
 *      `send_ledger.id` É a idempotency_key, enviada em `metadata.idempotency_key`
 *      da mensagem;
 *   2. chamada ao handler; 'sent' → accepted; 'queued'/'failed' → registrados;
 *   3. retry pós-crash: 'accepted' pula; 'requested' PRIMEIRO procura em
 *      `messages` uma linha com essa idempotency_key (o crash pode ter sido
 *      DEPOIS do envio) — achou, reconcilia o ledger sem reenviar; 'failed'
 *      rotaciona o id (tentativa lógica nova).
 */
import { sendWithLedger, pgSendLedger, type SendOutcome } from './send-ledger';
export type { SendOutcome, SendLedgerStatus } from './send-ledger';

import { ApiError } from '@/lib/api/types';
import { sendMessageHandler } from '@/app/api/v1/messages/_handler';
import type { Message } from '@/lib/types/messaging';

import type { Queryable } from '../../queue/queue';
import { cancelJob, rescheduleJob, type JobRow } from '../../queue/queue';
import { cancelPendingCronsForLead } from '../../cron/scheduler';
import { CrmTransportError, type CrmEdgeConfig } from './mcp-client';

/** Erro de negócio não classificado do handler (ex.: conversa inexistente) — ledger fica 'requested'. */
export class SendToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendToolError';
  }
}

export interface SendMessageInput {
  agentOperation?: AgentOperationContext;
  jobClaim?: JobClaim;
  tenantId: string;
  leadId: string | null;
  jobId: string;
  /** Posição da mensagem no turno (1..n) — com jobId forma a identidade da intenção. */
  seq: number;
  conversationId: string;
  body: string;
  /**
   * Presente = envio de TEMPLATE. O `body` continua sendo o texto RENDERIZADO — é
   * ele que entra no hash de idempotência e é ele que os gates de conteúdo avaliaram.
   * Trocar a chave por "nome do template" faria dois envios com valores diferentes
   * colidirem no ledger e o segundo virar `already_sent` sem ter saído.
   */
  template?: { name: string; language: string; values: Record<string, string> };
}

/** Fallback do ator ai_agent quando não há agente publicado (cfg.agentActorId). */
export const AGENT_ACTOR_ID = 'agent-engine';

/**
 * Envia UMA mensagem do turno pelo handler do app. Intenção exactly-once,
 * entrega at-least-once: throws (transporte) deixam o ledger em 'requested' —
 * o retry reconcilia por `messages.metadata.idempotency_key` antes de reenviar.
 */
export async function sendTurnMessage(
  db: Queryable,
  cfg: CrmEdgeConfig,
  input: SendMessageInput,
): Promise<SendOutcome> {
  if (input.agentOperation) await assertAgentOperationPg(db, input.agentOperation);
  const { rows: sourceJobs } = await db.query<{ kind: string; payload: Record<string, unknown> }>(
    'select payload,kind from job_queue where id=$1 and organization_id=$2 and contact_id=$3',
    [input.jobId, input.tenantId, input.leadId],
  );
  await requireCurrentServiceBoundary(
    db,
    parseServiceBoundary(sourceJobs[0]?.payload.service_boundary),
  );
  const proactiveContext =
    sourceJobs[0]?.kind === 'followup_turn' && input.leadId
      ? {
          organizationId: input.tenantId,
          contactId: input.leadId,
          jobId: input.jobId,
          jobClaim: input.jobClaim,
          enrollmentId:
            typeof sourceJobs[0].payload.followup_enrollment_id === 'string'
              ? sourceJobs[0].payload.followup_enrollment_id
              : undefined,
          nodeId:
            typeof sourceJobs[0].payload.node_id === 'string'
              ? sourceJobs[0].payload.node_id
              : undefined,
        }
      : undefined;
  if (proactiveContext) await assertAgendaEffectPg(db, proactiveContext);
  let meetingDelivery: MeetingDeliveryContext | undefined;
  if (sourceJobs[0]?.kind === 'transactional_delivery') {
    if (!input.jobClaim) throw new StaleServiceBoundaryError();
    meetingDelivery = {
      organizationId: input.tenantId,
      jobId: input.jobId,
      jobClaim: input.jobClaim,
    };
    await assertMeetingDeliveryPg(db, meetingDelivery);
  }
  let approvedReply: ApprovedReplyContext | undefined;
  if (sourceJobs[0]?.kind === 'approved_reply') {
    if (!input.jobClaim) throw new StaleServiceBoundaryError();
    approvedReply = {
      organizationId: input.tenantId,
      jobId: input.jobId,
      jobClaim: input.jobClaim,
    };
    const policy = await assertApprovedReplyPg(db, approvedReply);
    if (policy.body !== input.body || policy.conversation_id !== input.conversationId)
      throw new StaleServiceBoundaryError();
  }
  return sendWithLedger(pgSendLedger(db), input, async (idempotencyKey, messageId) => {
    let message: Message;
    try {
      message = await sendMessageHandler(
        cfg.supabase,
        {
          organization_id: input.tenantId,
          actor: { type: 'ai_agent', id: cfg.agentActorId ?? AGENT_ACTOR_ID, role: 'manager' },
          requestId: idempotencyKey,
          serviceBoundary: parseServiceBoundary(sourceJobs[0]?.payload.service_boundary),
          proactiveContext,
          meetingDelivery,
          approvedReply,
          agentOperation: input.agentOperation,
          internalMessageId: messageId,
        },
        {
          conversation_id: input.conversationId,
          ...(input.template
            ? {
                type: 'template' as const,
                template_name: input.template.name,
                template_language: input.template.language,
                template_values: input.template.values,
              }
            : { type: 'text' as const }),
          body: input.body,
          metadata: { idempotency_key: idempotencyKey },
        },
      );
    } catch (err) {
      if (err instanceof AgendaDeferredError || err instanceof StaleServiceBoundaryError) throw err;
      if (err instanceof ApiError && err.status === 403) {
        throw err;
      }
      if (err instanceof ApiError && err.status === 404) {
        await touchLedgerError(db, input.tenantId, idempotencyKey, 'conversa não encontrada');
        throw new SendToolError('envio recusado: conversa não encontrada');
      }
      // Qualquer outra falha (Supabase fora, erro interno do handler): transiente —
      // o ledger fica 'requested' e o replay reconcilia pela key.
      const msg = err instanceof Error ? err.message : String(err);
      await touchLedgerError(db, input.tenantId, idempotencyKey, msg);
      throw new CrmTransportError(`handler de envio indisponível: ${msg.slice(0, 120)}`);
    }

    return message;
  });
}

async function touchLedgerError(
  db: Queryable,
  org: string,
  id: string,
  errorText: string,
): Promise<void> {
  await db.query(
    `update send_ledger set last_error = $2, updated_at = now() where id = $1 and organization_id = $3`,
    [id, errorText.slice(0, 300), org],
  );
}

export type SendDisposition =
  /** Job cancelado em definitivo (veto is_blocked) — não re-tenta. */
  | { action: 'canceled'; job: JobRow | null }
  /** Job devolvido a 'pending' com run_after adiado, sem consumir attempts. */
  | { action: 'requeued'; job: JobRow | null }
  /** Nada a fazer com o job aqui: 'sent'/'already_sent' seguem para complete; 'failed' segue para failJob. */
  | { action: 'none' };

/**
 * Disposição do JOB conforme o outcome do envio:
 * - blocked → cancela o job (terminal — opt-out não é incidente) e cancela TODOS
 *   os follow-ups agendados do contato (irrevogável, regra dura nº 2). A fonte
 *   do bloqueio JÁ é contacts.is_blocked — não existe mais cache a atualizar;
 * - queued → reagenda com `delayMs` (knob SEND_QUEUED_RETRY_MS) SEM consumir
 *   attempts — sessão fora não pode matar mensagem de lead saudável;
 * - demais → responsabilidade do worker (complete/failJob pelos caminhos normais).
 */
export async function applySendOutcome(
  db: Queryable,
  outcome: SendOutcome,
  job: {
    jobId: string;
    workerId: string;
    tenantId: string;
    leadId: string | null;
    jobClaim?: JobClaim;
  },
  knobs: { queuedRetryDelayMs: number },
): Promise<SendDisposition> {
  switch (outcome.kind) {
    case 'blocked': {
      const canceled = await cancelJob(
        db,
        job.jobId,
        job.workerId,
        'envio vetado pelo sink: contato bloqueado (is_blocked) — opt-out irrevogável',
        job.jobClaim?.acquired_at,
      );
      if (job.leadId) {
        await cancelPendingCronsForLead(db, job.tenantId, job.leadId);
      }
      return { action: 'canceled', job: canceled };
    }
    case 'queued': {
      const requeued = await rescheduleJob(db, job.jobId, job.workerId, {
        delayMs: knobs.queuedRetryDelayMs,
        acquiredAt: job.jobClaim?.acquired_at,
        reason: 'sessão do canal fora (resposta queued) — reagendado sem consumir attempts',
      });
      return { action: 'requeued', job: requeued };
    }
    default:
      return { action: 'none' };
  }
}
