/**
 * Camada de banco + loop do cron persistente (F3-01; achado OpenClaw 1.2). Irmão
 * da fila (queue/queue.ts): o cron AGENDA para o futuro e, no disparo, ENFILEIRA um
 * job em job_queue — nunca reimplementa a fila. Todo o estado mora em cron_jobs
 * (0013), então sobrevive a restart.
 *
 * Disparo de UM cron por transação, com o row-lock segurado do claim ao commit:
 *   1. `select ... for update skip locked limit 1` — dois tickers/uma instância
 *      reiniciada nunca disparam o mesmo cron (exactly-once sob concorrência);
 *   2. enqueue do job (savepoint em volta) + reagendamento no MESMO commit — restart
 *      no meio faz rollback: o cron volta ao claim (nada perdido) e nada foi
 *      enfileirado (nada duplicado);
 *   3. falha do enqueue: `rollback to savepoint` desfaz o enqueue parcial SEM soltar
 *      o lock, e o desfecho (backoff transiente OU desabilita+inbox permanente) é
 *      aplicado e commitado na MESMA transação — inbox 1× garantido.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import type pg from 'pg';

import type { Logger } from '../obs/logger';
import { enqueueJob, type JobKind, type Queryable } from '../queue/queue';
import {
  classifyFireError,
  computeInitialRunAt,
  computeNextRunAt,
  retryBackoffMs,
  type CronSpec,
} from './schedule';

export interface CronJobRow {
  id: string;
  tenant_id: string;
  lead_id: string;
  kind: 'at' | 'every' | 'cron';
  interval_ms: string | null; // bigint chega como string do pg
  cron_expr: string | null;
  tz: string;
  job_kind: JobKind;
  payload: Record<string, unknown>;
  next_run_at: Date;
  enabled: boolean;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Mesma disciplina do normalizeError da fila: 1ª linha truncada — PII fora do log. */
function errMsg(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message.split('\n', 1)[0] ?? '').slice(0, 300);
}

function specFromRow(row: CronJobRow): CronSpec {
  switch (row.kind) {
    case 'at':
      return { kind: 'at', at: row.next_run_at };
    case 'every':
      return { kind: 'every', intervalMs: Number(row.interval_ms) };
    case 'cron':
      return { kind: 'cron', expr: row.cron_expr ?? '', tz: row.tz };
  }
}

export interface ScheduleCronInput {
  leadId: string;
  spec: CronSpec;
  /** kind do job a enfileirar no disparo (default followup_turn). */
  jobKind?: JobKind;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  /** janela do stagger determinístico (knob CRON_STAGGER_WINDOW_MS). */
  staggerWindowMs: number;
  /** clock injetável (testes de stagger/backoff). */
  now?: () => number;
}

/**
 * Cria um cron. next_run_at do 1º disparo já sai com o offset de stagger aplicado
 * (base do kind + hash(lead)) — jobs no mesmo minuto nascem espalhados. `organization`
 * do lead é herdada pelo job só no disparo (via enqueue), nunca daqui.
 */
export async function scheduleCronJob(
  db: pg.Pool,
  tenantId: string,
  input: ScheduleCronInput,
): Promise<CronJobRow> {
  const nowMs = (input.now ?? Date.now)();
  const nextRunAt = computeInitialRunAt(input.spec, nowMs, input.staggerWindowMs, input.leadId);
  const spec = input.spec;
  const { rows } = await db.query<CronJobRow>(
    `insert into cron_jobs
       (tenant_id, lead_id, kind, interval_ms, cron_expr, tz, job_kind, payload, next_run_at, max_attempts)
     values
       ($1, $2, $3, $4, $5, coalesce($6, 'UTC'), coalesce($7, 'followup_turn'), $8, $9, coalesce($10::smallint, 5))
     returning *`,
    [
      tenantId,
      input.leadId,
      spec.kind,
      spec.kind === 'every' ? spec.intervalMs : null,
      spec.kind === 'cron' ? spec.expr : null,
      spec.kind === 'cron' ? spec.tz : null,
      input.jobKind ?? null,
      input.payload ?? {},
      nextRunAt,
      input.maxAttempts ?? null,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('cron_jobs insert não devolveu linha');
  return row;
}

/**
 * Cancela (enabled=false) TODOS os cron_jobs pendentes do lead — escopo tenant+lead
 * (regra dura nº 1). Idempotente e reusável: o opt-out irrevogável (F4-07) e o handoff
 * humano (F4-06) precisam da MESMA garantia — nenhum follow-up agendado pode disparar
 * depois. Devolve quantos foram cancelados (para o trace estruturado; ids não são PII).
 */
export async function cancelPendingCronsForLead(
  db: Queryable,
  tenantId: string,
  leadId: string,
): Promise<number> {
  const { rowCount } = await db.query(
    `update cron_jobs set enabled = false, updated_at = now()
     where tenant_id = $1 and lead_id = $2 and enabled = true`,
    [tenantId, leadId],
  );
  return rowCount ?? 0;
}

export interface CronTickConfig {
  /** máximo de crons disparados por tick. */
  batchSize: number;
  /** janela do stagger no reagendamento recorrente (CRON_STAGGER_WINDOW_MS). */
  staggerWindowMs: number;
  /** base do backoff exponencial do retry transiente (CRON_RETRY_BASE_MS). */
  retryBaseMs: number;
  /** clock injetável (testes). */
  now?: () => number;
}

export interface CronTickResult {
  fired: number;
  retried: number;
  disabled: number;
}

type FailureOutcome = { outcome: 'retried' | 'disabled'; classification: string; attempts: number };

/**
 * Aplica o desfecho de uma falha de disparo DENTRO da transação (row ainda locada):
 * permanente (SQLSTATE 22/23) OU transiente esgotado → desabilita + inbox 1×;
 * transiente com folga → backoff exponencial. Escala humana via inbox_items
 * (runtime — nunca arquivo), sem PII.
 */
async function applyFailure(
  client: pg.PoolClient,
  cron: CronJobRow,
  cfg: CronTickConfig,
  nowMs: number,
  err: unknown,
): Promise<FailureOutcome> {
  const reason = errMsg(err);
  const classification = classifyFireError(err);
  const attempts = cron.attempts + 1;
  if (classification === 'permanent' || attempts >= cron.max_attempts) {
    await client.query(
      `update cron_jobs set enabled = false, attempts = $2, last_error = $3, updated_at = now() where id = $1`,
      [cron.id, attempts, reason],
    );
    await client.query(
      `insert into inbox_items (tenant_id, kind, severity, title, body, ref_kind, ref_id)
       values ($1, 'job_dead', 'critical', 'Cron desabilitado após falha de disparo', $2, 'cron_jobs', $3)`,
      [cron.tenant_id, `kind=${cron.kind}; job_kind=${cron.job_kind}; motivo=${classification}; attempts=${attempts}`, cron.id],
    );
    return { outcome: 'disabled', classification, attempts };
  }
  const backoffMs = retryBackoffMs(attempts, cfg.retryBaseMs);
  await client.query(
    `update cron_jobs set attempts = $2, next_run_at = $3, last_error = $4, updated_at = now() where id = $1`,
    [cron.id, attempts, new Date(nowMs + backoffMs), reason],
  );
  return { outcome: 'retried', classification, attempts };
}

/**
 * Dispara no máximo UM cron vencido. Devolve 'empty' quando não há vencido claimável.
 * O lock é segurado do claim ao commit; a falha do enqueue é isolada por savepoint.
 */
async function fireOneDue(
  pool: pg.Pool,
  cfg: CronTickConfig,
  log: Logger,
): Promise<'fired' | 'retried' | 'disabled' | 'empty'> {
  const nowMs = (cfg.now ?? Date.now)();
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query<CronJobRow>(
      `select * from cron_jobs
       where enabled = true and next_run_at <= $1
       order by next_run_at
       limit 1
       for update skip locked`,
      [new Date(nowMs)],
    );
    const cron = rows[0];
    if (cron === undefined) {
      await client.query('rollback');
      return 'empty';
    }
    const spec = specFromRow(cron);
    try {
      await client.query('savepoint fire');
      await enqueueJob(client, cron.tenant_id, {
        kind: cron.job_kind,
        leadId: cron.lead_id,
        payload: cron.payload,
      });
      const next = computeNextRunAt(spec, cron.next_run_at.getTime(), nowMs, cfg.staggerWindowMs, cron.lead_id);
      if (next === null) {
        // one-shot ('at') concluído: desabilita.
        await client.query(
          `update cron_jobs set enabled = false, attempts = 0, last_error = null, updated_at = now() where id = $1`,
          [cron.id],
        );
      } else {
        await client.query(
          `update cron_jobs set next_run_at = $2, attempts = 0, last_error = null, updated_at = now() where id = $1`,
          [cron.id, next],
        );
      }
      await client.query('commit');
      return 'fired';
    } catch (fireErr) {
      await client.query('rollback to savepoint fire'); // desfaz enqueue parcial, mantém o lock
      const failure = await applyFailure(client, cron, cfg, nowMs, fireErr);
      await client.query('commit');
      if (failure.outcome === 'disabled') {
        log.error('cron: job desabilitado por falha de disparo', {
          cron_job_id: cron.id,
          classification: failure.classification,
          attempts: failure.attempts,
        });
      } else {
        log.warn('cron: disparo falhou — retry com backoff', {
          cron_job_id: cron.id,
          attempts: failure.attempts,
        });
      }
      return failure.outcome;
    }
  } catch (err) {
    try {
      await client.query('rollback');
    } catch (rollbackErr) {
      throw new AggregateError([err, rollbackErr], 'rollback falhou no disparo do cron');
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Um tick: dispara até `batchSize` crons vencidos, um por transação (isolamento —
 * um cron podre não derruba os demais). Para quando esgota os vencidos claimáveis.
 */
export async function tickCron(pool: pg.Pool, cfg: CronTickConfig, log: Logger): Promise<CronTickResult> {
  const result: CronTickResult = { fired: 0, retried: 0, disabled: 0 };
  for (let i = 0; i < cfg.batchSize; i += 1) {
    const outcome = await fireOneDue(pool, cfg, log);
    if (outcome === 'empty') break;
    result[outcome] += 1;
  }
  return result;
}

export interface CronLoopConfig extends CronTickConfig {
  /** ritmo do ticker (CRON_TICK_INTERVAL_MS). */
  intervalMs: number;
}

/**
 * Loop de produção do cron (main.ts). Roda contra o harness — só enfileira, não fala
 * com CRM/WAHA. Tick falhado loga e espera o intervalo (o próprio poll é a
 * recuperação). Encerra quando `signal` aborta (graceful shutdown).
 */
export async function runCronLoop(
  pool: pg.Pool,
  cfg: CronLoopConfig,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const tick = await tickCron(pool, cfg, log);
      if (tick.fired + tick.retried + tick.disabled > 0) log.info('cron: tick processado', { ...tick });
    } catch (err) {
      log.error('cron: tick falhou — tenta no próximo intervalo', { error: errMsg(err) });
    }
    try {
      await sleep(cfg.intervalMs, undefined, { signal });
    } catch {
      break; // abort durante o sleep = shutdown
    }
  }
}
