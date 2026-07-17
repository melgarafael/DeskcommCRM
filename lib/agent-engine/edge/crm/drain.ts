/**
 * Drain pós-fusão: consome `ai_agent.dispatch_requested` do event_log (MESMO
 * banco — a role vendaval_drain e o transporte cross-banco morreram) e enfileira
 * jobs `inbound_turn` na fila durável do harness.
 *
 * Garantias:
 *   - organization_id vem da LINHA do evento (fonte confiável), nunca do payload;
 *   - at-least-once + dedup: claim CAS (pending→processing) + unique
 *     (organization_id, source_event_id) em job_queue com captura de 23505;
 *   - coalescência de rajada: mensagens do MESMO contato dentro da janela de
 *     debounce viram UM job (o turno lê o histórico completo e responde a todas);
 *   - grupos @g.us: skip (regra dura nº 12) — evento marcado processed sem job;
 *   - eventos 'processing' órfãos (crash do worker) voltam a 'pending' por timeout.
 */
import { z } from 'zod';
import type pg from 'pg';

import type { Logger } from '../../obs/logger';
import { enqueueJob } from '../../queue/queue';

const DRAIN_CONSUMER = 'agent-engine';

const dispatchPayloadSchema = z
  .object({
    conversation_id: z.string().uuid(),
    contact_id: z.string().uuid(),
    channel_session_id: z.string().uuid(),
    inbound_message_id: z.string().uuid(),
  })
  .passthrough();

interface EventRow {
  id: string;
  organization_id: string;
  payload: unknown;
  attempts: number;
}

export interface DrainKnobs {
  batchSize: number;
  intervalMs: number;
  idleIntervalMs: number;
  /** Janela de coalescência de rajada inbound por contato (0 = sem debounce). */
  debounceMs: number;
  /** Evento 'processing' órfão volta a 'pending' após isto. */
  reapTimeoutMs: number;
}

/** Um tick do drain: claima um lote de eventos e os transforma em jobs. */
export async function drainTick(
  pool: pg.Pool,
  knobs: DrainKnobs,
  log: Logger,
): Promise<number> {
  // Reaper de eventos órfãos — barato (update indexado), roda a cada tick.
  await pool.query(
    `update event_log set status = 'pending', updated_at = now()
     where event_type = 'ai_agent.dispatch_requested'
       and status = 'processing'
       and $1 = any(consumed_by)
       and updated_at < now() - make_interval(secs => $2 / 1000.0)`,
    [DRAIN_CONSUMER, knobs.reapTimeoutMs],
  );

  const { rows: events } = await pool.query<EventRow>(
    `update event_log e
     set status = 'processing', attempts = e.attempts + 1,
         consumed_by = array_append(array_remove(coalesce(e.consumed_by, '{}'), $2), $2),
         updated_at = now()
     where e.id in (
       select id from event_log
       where event_type = 'ai_agent.dispatch_requested'
         and status = 'pending'
         and (next_attempt_at is null or next_attempt_at <= now())
       order by created_at
       limit $1
       for update skip locked
     )
     returning e.id, e.organization_id, e.payload, e.attempts`,
    [knobs.batchSize, DRAIN_CONSUMER],
  );

  for (const event of events) {
    try {
      await processEvent(pool, event, knobs, log);
      await pool.query(
        `update event_log set status = 'processed', updated_at = now() where id = $1`,
        [event.id],
      );
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      const terminal = event.attempts >= 5;
      await pool.query(
        `update event_log
         set status = $2, last_error = $3, next_attempt_at = now() + interval '30 seconds',
             updated_at = now()
         where id = $1`,
        [event.id, terminal ? 'failed' : 'pending', message],
      );
      log.error('drain: evento falhou', { event_id: event.id, terminal, error: message });
    }
  }
  return events.length;
}

async function processEvent(
  pool: pg.Pool,
  event: EventRow,
  knobs: DrainKnobs,
  log: Logger,
): Promise<void> {
  const parsed = dispatchPayloadSchema.safeParse(event.payload);
  if (!parsed.success) {
    // Payload fora do contrato do ingest — evento é descartável (processed), não
    // retryável: re-tentar não conserta shape.
    log.warn('drain: payload de dispatch fora do contrato — evento descartado', {
      event_id: event.id,
    });
    return;
  }
  const p = parsed.data;

  // Grupos: skip, sem exceção (regra dura nº 12).
  const { rows: convRows } = await pool.query<{ is_group: boolean }>(
    'select is_group from conversations where organization_id = $1 and id = $2',
    [event.organization_id, p.conversation_id],
  );
  if (convRows[0]?.is_group !== false) {
    log.info('drain: conversa de grupo ou inexistente — evento pulado', { event_id: event.id });
    return;
  }

  // Coalescência: já existe job PENDING futuro deste contato → esta mensagem
  // entra de carona (o turno lê o histórico completo). Evento vira processed.
  if (knobs.debounceMs > 0) {
    const { rows: pendingRows } = await pool.query<{ id: string }>(
      `select id from job_queue
       where organization_id = $1 and contact_id = $2
         and kind = 'inbound_turn' and status = 'pending' and run_after > now()
       limit 1`,
      [event.organization_id, p.contact_id],
    );
    if (pendingRows[0]) {
      log.info('drain: rajada coalescida em job pendente', {
        event_id: event.id,
        job_id: pendingRows[0].id,
      });
      return;
    }
  }

  const runAfter = knobs.debounceMs > 0 ? new Date(Date.now() + knobs.debounceMs) : undefined;
  const { job, deduped } = await enqueueJob(pool, event.organization_id, {
    kind: 'inbound_turn',
    leadId: p.contact_id,
    sourceEventId: event.id,
    payload: {
      conversation_id: p.conversation_id,
      contact_id: p.contact_id,
      channel_session_id: p.channel_session_id,
      inbound_message_id: p.inbound_message_id,
      crm_event_id: event.id,
    },
    ...(runAfter !== undefined ? { runAfter } : {}),
  });
  log.info('drain: job de turno enfileirado', { event_id: event.id, job_id: job.id, deduped });
}

/** Loop do drain — polling com backoff adaptativo (ocioso = tick mais lento). */
export async function runDrainLoop(
  pool: pg.Pool,
  knobs: DrainKnobs,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    let drained = 0;
    try {
      drained = await drainTick(pool, knobs, log);
    } catch (err) {
      log.error('drain: tick falhou', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
    }
    const waitMs = drained > 0 ? knobs.intervalMs : knobs.idleIntervalMs;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
