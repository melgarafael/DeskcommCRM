/**
 * Handler do job `followup_turn` (F3-03; blueprint 1.3) — a peça BUILD da
 * continuidade. A F3-01 (cron persistente) dispara e a F3-02 (tool schedule_followup)
 * agenda a promessa; aqui, NO DISPARO, o harness COMPUTA o delta temporal e injeta o
 * bloco de re-entrada ANTES do turno: "passaram N dias desde a última resposta, você
 * prometeu X, motivo Y, a última coisa que o lead disse foi Z". É a lacuna confirmada
 * em OpenClaw/Hermes que transforma continuação fria em retomada natural.
 *
 * Reusa runAgentTurn (F2-09) por inteiro — sessão fresca, loop de tools, checkpoint,
 * veto. A ÚNICA diferença é a abertura: o bloco temporal entra no SUFIXO (messages),
 * DEPOIS do prefixo cacheável (system do playbook + tools — F2-17), então não
 * invalida o cache org-wide. O delta é RELATIVO ao now do run (clock injetável),
 * nunca persistido estático.
 *
 * Ids de envio (conversa + número) vêm da ROW do lead no harness (fonte confiável),
 * NUNCA do payload do modelo — o cron só carrega o snapshot da promessa (F3-02).
 */
import { z } from 'zod';
import type pg from 'pg';

import { withFields } from '../obs/logger';
import type { JobRow } from '../queue/queue';
import { getLeadContext, type LeadContext } from '../edge/crm/get-lead-context';
import { WahaChannelAdapter } from '../edge/channel/waha-adapter';
import { applySendOutcome } from '../edge/crm/send-message';
import { runBeforeSend } from '../guardrails/before-send';
import { classifyPromise } from '../guardrails/promise/semantic';
import { scheduleCronJob } from '../cron/scheduler';
import {
  JobSettledError,
  ritualBlocks,
  runAgentTurn,
  type InboundTurnDeps,
  type LeadCheckpointRow,
} from './inbound-turn';
import { isLeadInHandoff } from './human-handoff';
import type { LeadStateRow } from './lead-state';
import { loadReentryTemplate, pickReentryVariant } from './reentry-template';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * Payload que o cron enfileira no disparo (F3-02 grava reason/promise/promised_at/
 * context_snapshot). Tolerante: um follow-up de origem futura (re-entrada iniciada
 * pelo sistema, sem promessa registrada) enfileira sem esses campos e ainda roda —
 * acc3 (variante mínima, sem promessa inventada).
 */
export const followupTurnPayloadSchema = z
  .object({
    reason: z.string().optional(),
    promise: z.string().optional(),
    promised_at: z.string().optional(),
    context_snapshot: z.string().nullable().optional(),
    // F3-04: 'template' = re-entrada DETERMINÍSTICA — envia a variante versionada
    // direto pela cadeia de guardrails, sem LLM (custo $0, blueprint). Ausente/'agent'
    // = run normal do agente (comportamento F3-03 intocado).
    mode: z.enum(['agent', 'template']).optional(),
  })
  .passthrough();

/** Duração humana pt-br do intervalo desde a última resposta — só ordem de grandeza. */
function humanizeElapsed(ms: number): string {
  if (ms >= DAY_MS) {
    const days = Math.floor(ms / DAY_MS);
    return days === 1 ? '1 dia' : `${days} dias`;
  }
  if (ms >= HOUR_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    return hours === 1 ? '1 hora' : `${hours} horas`;
  }
  return 'menos de uma hora';
}

/**
 * Bloco temporal de re-entrada. Com promessa → variante completa; sem promessa →
 * variante mínima coerente (acc3), nunca uma promessa inventada. O delta N dias é
 * medido do `now` (clock do run) até a última resposta do lead (última inbound do
 * contexto); sem inbound no contexto, cai numa abertura de retomada sem delta.
 */
export function buildTemporalBlock(input: {
  now: Date;
  reason?: string | undefined;
  promise?: string | undefined;
  promisedAt?: string | undefined;
  lastInbound: { body: string; sentAt: string } | null;
}): string {
  const parts: string[] = [];

  if (input.lastInbound !== null) {
    const elapsedMs = input.now.getTime() - Date.parse(input.lastInbound.sentAt);
    parts.push(
      Number.isNaN(elapsedMs)
        ? 'Você está retomando o contato com o lead após o intervalo combinado.'
        : `Passaram ${humanizeElapsed(Math.max(0, elapsedMs))} desde a última resposta do lead.`,
    );
  } else {
    parts.push('Você está retomando o contato com o lead; não há resposta recente registrada na conversa.');
  }

  const promise = input.promise?.trim();
  if (promise) {
    parts.push(
      input.promisedAt ? `Você prometeu: ${promise} (para ${input.promisedAt}).` : `Você prometeu: ${promise}.`,
    );
  }

  const reason = input.reason?.trim();
  if (reason) {
    parts.push(`Motivo do follow-up: ${reason}.`);
  }

  if (input.lastInbound !== null) {
    parts.push(`A última coisa que o lead disse foi: "${input.lastInbound.body}".`);
  }

  return parts.join(' ');
}

/** Abertura do follow-up: bloco temporal no topo do sufixo + o ritual padrão. */
function buildFollowupOpeningMessage(
  temporalBlock: string,
  previous: LeadCheckpointRow | null,
  leadState: LeadStateRow | null,
  context: LeadContext,
  notesIndexBlock: string,
): string {
  return [
    'Follow-up agendado: você havia combinado retornar a este lead — NÃO houve nova mensagem dele desde então.',
    '',
    '## Contexto temporal do follow-up',
    temporalBlock,
    '',
    ...ritualBlocks(previous, leadState, context, notesIndexBlock),
    '',
    'Retome a conversa com naturalidade usando a tool send_message — NUNCA escreva a resposta como texto direto',
    '(texto fora de tool é descartado pelo runtime). Use get_lead_context se precisar reler o contexto.',
    'Houve avanço REAL no funil neste turno? Marque-o com update_lead_state (só o próximo estágio válido).',
    'Aprendeu algo durável sobre o lead? Salve com save_lead_note (a headline entra no índice de memória).',
  ].join('\n');
}

/** Última mensagem inbound do contexto (a "última coisa que o lead disse" — Z). */
function lastInboundOf(context: LeadContext): { body: string; sentAt: string } | null {
  for (let i = context.messages.length - 1; i >= 0; i -= 1) {
    const m = context.messages[i]!;
    if (m.direction === 'inbound') {
      return { body: m.body, sentAt: m.sent_at };
    }
  }
  return null;
}

/**
 * Handler de `followup_turn` para o registry do daemon (main.ts). Resolve os ids de
 * envio da row do lead (nunca do payload) e injeta o bloco temporal no sufixo antes
 * de delegar ao núcleo compartilhado do run (runAgentTurn).
 */
export function createFollowupTurnHandler(deps: InboundTurnDeps) {
  return async (job: JobRow, pool: pg.Pool, ctx: { workerId: string }): Promise<void> => {
    const tenantId = job.organization_id;
    const leadId = job.contact_id;
    if (leadId === null) {
      throw new Error('job followup_turn sem contact_id — o CHECK da fila deveria impedir');
    }
    const payload = followupTurnPayloadSchema.parse(job.payload);

    // Ids de envio resolvidos da conversa 1:1 mais recente do contato (fonte
    // confiável, mesmo banco — a tabela-espelho leads morreu na fusão). Um follow-up
    // só existe para contato que já conversou; ausência é anomalia → dead-letter.
    const { rows } = await pool.query<{ id: string; channel_session_id: string | null }>(
      `select id, channel_session_id from conversations
       where organization_id = $1 and contact_id = $2 and is_group = false
       order by last_message_at desc nulls last limit 1`,
      [tenantId, leadId],
    );
    const conv = rows[0];
    if (conv === undefined || conv.channel_session_id === null) {
      throw new Error('followup_turn sem conversa/número do contato — impossível retomar o contato');
    }

    const clock = deps.clock ?? ((): Date => new Date());

    // F3-04: caminho determinístico ($0) — envia o template versionado direto pela
    // cadeia de guardrails, sem chamar o modelo. É um CAMINHO ADICIONAL: o run do
    // agente (abaixo) segue intocado quando o modo não é 'template'.
    if (payload.mode === 'template') {
      await runDeterministicReentry(deps, job, pool, ctx, clock, {
        tenantId,
        leadId,
        channelSessionId: conv.channel_session_id,
        conversationId: conv.id,
      });
      return;
    }

    await runAgentTurn(deps, job, pool, ctx, {
      channelSessionId: conv.channel_session_id,
      conversationId: conv.id,
      buildOpening: ({ previous, leadState, context, notesIndexBlock }) => {
        const temporalBlock = buildTemporalBlock({
          now: clock(),
          reason: payload.reason,
          promise: payload.promise,
          promisedAt: payload.promised_at,
          lastInbound: lastInboundOf(context),
        });
        return buildFollowupOpeningMessage(temporalBlock, previous, leadState, context, notesIndexBlock);
      },
    });
  };
}

interface ReentrySendTarget {
  tenantId: string;
  leadId: string;
  channelSessionId: string;
  conversationId: string;
}

/**
 * Re-entrada DETERMINÍSTICA (F3-04): carrega o template ativo por ponteiro, escolhe a
 * variante do lead (hash — acc2) e a envia SEM LLM. Enviar continua sendo o sink
 * idempotente (F2-06) ATRÁS da cadeia de guardrails (F2-13): STOP/anti-ban/spinning
 * rodam igual ao caminho do agente — só o modelo é pulado ($0). Fora da janela
 * anti-ban o envio é RE-AGENDADO (nunca dropado — acc3).
 */
async function runDeterministicReentry(
  deps: InboundTurnDeps,
  job: JobRow,
  pool: pg.Pool,
  ctx: { workerId: string },
  clock: () => Date,
  target: ReentrySendTarget,
): Promise<void> {
  const { tenantId, leadId, channelSessionId, conversationId } = target;
  const runLog = withFields(deps.log, { job_id: job.id, tenant_id: tenantId, lead_id: leadId });

  // F4-07: silêncio DURÁVEL (bot_silenced_until — handoff explícito F4-06 OU opt-out
  // ambíguo) veta a re-entrada determinística ANTES de qualquer envio, igual ao NO-OP do
  // caminho do agente (runAgentTurn). Fecha o caso em que o STOP ambíguo silenciou o lead
  // mas o CRM ainda não marcou is_blocked (o stopGate por si não pega esse estado).
  if (await isLeadInHandoff(pool, tenantId, leadId)) {
    runLog.info('re-entrada determinística pulada — lead silenciado (handoff/opt-out)', { kind: job.kind });
    return;
  }

  // Template versionado por ponteiro (acc1): sem cache de processo — mover o ponteiro
  // ⇒ este disparo já usa a versão nova. Tenant sem template apontado = erro de
  // configuração (permanente): o job vira dead-letter + inbox pela fila, nunca envio mudo.
  const template = await loadReentryTemplate(pool, tenantId);
  if (template === null) {
    throw new Error('re-entrada determinística sem template apontado para o tenant — publique um template e mova o ponteiro');
  }
  const body = pickReentryVariant(leadId, template.variants);

  // STOP no turno (fonte: CRM via get_lead_context — regra dura nº 2), como o caminho
  // do agente. É leitura de CRM, não do modelo: o custo em LLM segue $0.
  const context = await getLeadContext(pool, deps.crmCfg, { tenantId, leadId }, {
    historyLimit: deps.knobs.historyLimit,
    maxTokens: deps.knobs.maxContextTokens,
  });
  if (!context.ok) {
    throw new Error(`re-entrada determinística falhou em get_lead_context (${context.error.code})`);
  }
  const optedOutThisTurn = context.context.contact.is_blocked;

  const channel = (deps.channel ?? ((p: pg.Pool) => new WahaChannelAdapter(p, deps.crmCfg)))(pool);

  // seq = 1: uma única mensagem determinística por disparo (identidade (job_id, 1) no
  // ledger F2-06). Enviar SÓ pela cadeia — nunca por baixo dela (CLAUDE.md princípio 2).
  const chain = await runBeforeSend({
    pool,
    log: runLog,
    tenantId,
    leadId,
    jobId: job.id,
    channelSessionId,
    body,
    optedOutThisTurn,
    // ponytail: mesmo débito do caminho do agente — o daily_message_limit do CRM ainda
    // não é lido no runtime; null cai nos degraus de warm-up (conservadores).
    crmDailyLimit: null,
    now: clock(),
    sleep: deps.sleep,
    // Gate LGPD (F4-09): base legal/anonimização do CRM lidas no turno (fonte confiável).
    lgpd: context.lgpd,
    ...(deps.knobs.disclosureMode !== undefined ? { disclosureMode: deps.knobs.disclosureMode } : {}),
    // Gate 5 (F4-02/F4-08): mesma camada semântica do caminho do agente — a re-entrada
    // determinística também passa a candidata pela cadeia completa (ids da ROW do job).
    ...(deps.knobs.promiseSemantic?.enabled === true
      ? {
          classifyPromiseSemantic: (candidate: string) =>
            classifyPromise(
              pool,
              deps.llmCfg,
              { tenantId, leadId, jobId: job.id },
              { candidate, ...(deps.knobs.promiseSemantic?.model !== undefined ? { model: deps.knobs.promiseSemantic.model } : {}) },
              { ...(deps.registry !== undefined ? { registry: deps.registry } : {}), log: runLog },
            ),
        }
      : {}),
    // finalBody = corpo após a cadeia (disclosureGate F4-05 pode prependar o disclosure).
    send: (finalBody) => channel.send({ tenantId, leadId, jobId: job.id, seq: 1, conversationId, body: finalBody }),
  });

  if (chain.status === 'vetoed') {
    // acc3: veto por JANELA anti-ban não dropa — re-agenda para a próxima abertura
    // (7h + jitter, já calculada pelo gate). Demais vetos (STOP irrevogável, spinning)
    // NÃO re-agendam: o trace do gate já os registrou.
    if (chain.code === 'outside_window' && chain.nextAllowedAt !== undefined) {
      await rescheduleReentry(pool, {
        tenantId,
        leadId,
        jobId: job.id,
        at: chain.nextAllowedAt,
        payload: job.payload,
      });
      runLog.info('re-entrada re-agendada por janela anti-ban', {
        code: chain.code,
        next_run_at: chain.nextAllowedAt.toISOString(),
      });
      return;
    }
    runLog.info('re-entrada determinística vetada pela cadeia — não re-agendada', { code: chain.code });
    return;
  }

  const outcome = chain.outcome;
  switch (outcome.kind) {
    case 'sent':
    case 'already_sent':
    case 'queued':
      // 'queued' = o canal aceitou e segura (sessão fora) — sob custódia do CRM, não
      // re-agenda (mesma disposição do caminho do agente).
      runLog.info('re-entrada determinística concluída', { kind: outcome.kind });
      return;
    case 'blocked':
      // veto permanente do sink (is_blocked): cancela o job e cacheia o opt-out — a
      // fonte é o CRM, nunca revertido (regra dura nº 2).
      await applySendOutcome(pool, outcome, { jobId: job.id, workerId: ctx.workerId, tenantId, leadId }, {
        queuedRetryDelayMs: deps.knobs.queuedRetryDelayMs,
      });
      throw new JobSettledError('re-entrada determinística vetada pelo sink (is_blocked) — job cancelado em definitivo');
    case 'failed':
      throw new Error('re-entrada determinística: CRM marcou o envio como failed — run re-tentado pela fila');
    case 'unavailable':
      throw new Error(`re-entrada determinística: canal indisponível (${outcome.reason}) — run re-tentado pela fila`);
  }
}

/**
 * Re-agenda a re-entrada para `at` (próxima janela válida) num cron_job 'at' one-shot
 * (F3-01), reusando o payload de origem (mantém mode='template'). IDEMPOTENTE por job
 * de origem: dois runs do MESMO job (retry pós-crash) criam UM só cron. staggerWindowMs
 * 0 de propósito — o jitter anti-ban já está embutido em `at` (nextAllowedAt do gate),
 * não é um número novo escondido.
 * ponytail: check-then-insert é seguro porque o followup_turn de um lead roda numa lane
 * serializada (F2-03) e o retry é sequencial; se um dia rodar concorrente por lead, vira
 * unique index parcial em (tenant_id, lead_id, payload->>'reschedule_of').
 */
async function rescheduleReentry(
  pool: pg.Pool,
  input: { tenantId: string; leadId: string; jobId: string; at: Date; payload: Record<string, unknown> },
): Promise<void> {
  const { rowCount } = await pool.query(
    `select 1 from cron_jobs
     where organization_id = $1 and contact_id = $2 and payload->>'reschedule_of' = $3`,
    [input.tenantId, input.leadId, input.jobId],
  );
  if (rowCount !== null && rowCount > 0) {
    return; // já re-agendado para este job (idempotência)
  }
  await scheduleCronJob(pool, input.tenantId, {
    leadId: input.leadId,
    spec: { kind: 'at', at: input.at },
    jobKind: 'followup_turn',
    payload: { ...input.payload, reschedule_of: input.jobId },
    staggerWindowMs: 0,
  });
}
