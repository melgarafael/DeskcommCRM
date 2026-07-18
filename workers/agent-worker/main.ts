/**
 * Worker 24/7 do agent-engine (fusão Vendaval → DeskcommCRM) — o processo
 * long-running que o CRM não tinha: fila durável, cron/follow-up, drain do
 * event_log e os turnos do agente rico.
 *
 * Ritual de boot: env (Zod) → check do schema do harness (recusa subir sem a
 * migration 0050 aplicada — aplicar é ato de deploy) → solta órfãos → healthz →
 * loops (worker, drain, cron, holds, saúde do número).
 *
 * Graceful shutdown: SIGTERM/SIGINT → para de claimar, drena jobs em curso até
 * SHUTDOWN_GRACE_MS, fecha healthz e pool, sai 0. Morte súbita é o caso do
 * reaper — lease expira e o job volta.
 *
 * Rodar: `pnpm worker` (tsx) — dev com --env-file=.env.local; container via
 * Dockerfile.worker (serviço `worker` do docker-compose).
 */
import http from 'node:http';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import type pg from 'pg';

import {
  createInboundTurnHandler,
  type InboundTurnDeps,
} from '@/lib/agent-engine/agent/inbound-turn';
import { createFollowupTurnHandler } from '@/lib/agent-engine/agent/followup-turn';
import { runCronLoop } from '@/lib/agent-engine/cron/scheduler';
import { createPool } from '@/lib/agent-engine/db/pool';
import { runDrainLoop } from '@/lib/agent-engine/edge/crm/drain';
import { crmEdgeConfigFromEnv } from '@/lib/agent-engine/edge/crm/mcp-client';
import { enforceHolds, sessionHealthMetrics } from '@/lib/agent-engine/edge/crm/session-watchdog';
import { runSessionWatchdogLoop } from '@/lib/agent-engine/edge/crm/session-reconciler';
import { runHealthLoop } from '@/lib/agent-engine/health/circuit';
import { runFlywheelLoop } from '@/lib/agent-engine/flywheel/live';
import { llmEdgeConfigFromEnv } from '@/lib/agent-engine/edge/llm/run-model-call';
import { loadEnv, type Env } from '@/lib/agent-engine/env';
import { createLogger, type Logger } from '@/lib/agent-engine/obs/logger';
import {
  evaluateCacheHitAlert,
  metricsSnapshot,
  recordRunMetrics,
  type CacheAlertKnobs,
} from '@/lib/agent-engine/obs/metrics';
import {
  claimJobs,
  completeJob,
  failJob,
  reapExpiredJobs,
  type JobKind,
  type JobRow,
} from '@/lib/agent-engine/queue/queue';

export interface JobHandlerContext {
  workerId: string;
}
export type JobHandler = (job: JobRow, pool: pg.Pool, ctx: JobHandlerContext) => Promise<void>;

/** 1ª linha, truncada — PII fora de log. */
function errMsg(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message.split('\n', 1)[0] ?? '').slice(0, 300);
}

/**
 * O boot NÃO aplica migrations (ato de deploy, via supabase/migrations + kit) —
 * só confere que o schema do harness existe e recusa subir sem ele.
 */
async function assertHarnessSchema(pool: pg.Pool): Promise<void> {
  const sentinels = ['job_queue', 'lead_checkpoints', 'agent_inbox_items', 'send_ledger'];
  const { rows } = await pool.query<{ missing: string }>(
    `select t.name as missing
     from unnest($1::text[]) as t(name)
     where to_regclass('public.' || t.name) is null`,
    [sentinels],
  );
  if (rows.length > 0) {
    throw new Error(
      `schema do harness ausente no banco (tabelas: ${rows.map((r) => r.missing).join(', ')}) — aplique a migration 0050_agent_harness antes de subir o worker`,
    );
  }
}

/** /healthz + /metrics do worker (bind 0.0.0.0 — o container expõe a porta). */
export function createHealthzServer(pool: pg.Pool, log: Logger, metricsWindowMs: number): http.Server {
  const respond = (res: http.ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const route = (req.url ?? '').split('?', 1)[0];
    if (req.method !== 'GET' || (route !== '/healthz' && route !== '/metrics')) {
      respond(res, 404, { error: 'not_found' });
      return;
    }
    if (route === '/metrics') {
      try {
        respond(res, 200, await metricsSnapshot(pool, metricsWindowMs));
      } catch (err) {
        log.error('metrics: snapshot indisponível', { error: errMsg(err) });
        respond(res, 503, { status: 'degraded', db: 'error' });
      }
      return;
    }
    const uptime_s = Math.round(process.uptime());
    try {
      const { rows } = await pool.query<{ status: string; n: number }>(
        'select status, count(*)::int as n from job_queue group by status',
      );
      const queue = { pending: 0, running: 0, dead: 0 };
      for (const row of rows) {
        if (row.status in queue) queue[row.status as keyof typeof queue] = row.n;
      }
      const sessions = await sessionHealthMetrics(pool);
      respond(res, 200, { status: 'ok', db: 'ok', queue, sessions, uptime_s });
    } catch (err) {
      log.error('healthz: banco indisponível', { error: errMsg(err) });
      respond(res, 503, { status: 'degraded', db: 'error', queue: null, sessions: null, uptime_s });
    }
  };
  return http.createServer((req, res) => void handle(req, res));
}

export async function startWorker(
  env: Env,
  handlers: Map<JobKind, JobHandler>,
  log: Logger = createLogger(),
): Promise<void> {
  const pool = createPool(env.SUPABASE_DB_URL, (err) =>
    log.error('pool: conexão caiu — recria no próximo uso', { error: errMsg(err) }),
  );
  const workerId = `agent-engine-${hostname()}-${process.pid}`;

  await assertHarnessSchema(pool);

  const bootReap = await reapExpiredJobs(pool, {
    visibilityTimeoutMs: env.QUEUE_VISIBILITY_TIMEOUT_MS,
  });
  if (bootReap.revived + bootReap.dead > 0) {
    log.warn('órfãos soltos no boot', bootReap);
  }

  const server = createHealthzServer(pool, log, env.METRICS_WINDOW_MS);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.HEALTH_PORT, '0.0.0.0', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : env.HEALTH_PORT;

  let shuttingDown = false;
  const inFlight = new Set<Promise<void>>();

  const reaperTimer = setInterval(() => {
    reapExpiredJobs(pool, { visibilityTimeoutMs: env.QUEUE_VISIBILITY_TIMEOUT_MS })
      .then((reaped) => {
        if (reaped.revived + reaped.dead > 0) log.warn('reaper devolveu jobs órfãos', reaped);
      })
      .catch((err: unknown) => log.error('reaper falhou', { error: errMsg(err) }));
  }, env.QUEUE_REAPER_INTERVAL_MS);

  // Holds de sessão/saúde: retém jobs de envio de número fora do ar (WORKING é a
  // fonte channel_sessions, mantida pelo webhook do WAHA) — ritmo do reaper serve.
  const holdsTimer = setInterval(() => {
    enforceHolds(pool)
      .then(({ held, released }) => {
        if (held + released > 0) log.info('holds de sessão aplicados', { held, released });
      })
      .catch((err: unknown) => log.error('enforceHolds falhou', { error: errMsg(err) }));
  }, env.QUEUE_REAPER_INTERVAL_MS);

  const loopsAbort = new AbortController();

  // Drain do event_log (mesmo banco pós-fusão) — transforma dispatch_requested em
  // jobs. SÓ liga quando este worker é o DONO do dispatch (AGENT_DISPATCH_CONSUMER
  // = 'engine'); em 'native' o dispatcher EPIC-13 consome e ligar o drain aqui
  // duplicaria/roubaria turnos (bug real da Fase 4).
  const drainLoop =
    env.AGENT_DISPATCH_CONSUMER === 'engine'
      ? runDrainLoop(
          pool,
          {
            batchSize: env.CRM_DRAIN_BATCH_SIZE,
            intervalMs: env.CRM_DRAIN_INTERVAL_MS,
            idleIntervalMs: env.CRM_DRAIN_IDLE_INTERVAL_MS,
            debounceMs: env.INBOUND_DEBOUNCE_MS,
            reapTimeoutMs: env.CRM_EVENT_REAP_TIMEOUT_MS,
          },
          log,
          loopsAbort.signal,
        )
      : (log.warn('drain DESLIGADO — AGENT_DISPATCH_CONSUMER=native (dispatcher EPIC-13 é o dono)', {}),
        Promise.resolve());

  // Watchdog de sessão (4A-2): reconcilia channel_sessions×WAHA + redrive de
  // queued. Liga só com as credenciais do WAHA no env (sem elas: warn + off).
  const sessionWatchdogLoop =
    env.WAHA_API_BASE_URL !== undefined && env.WAHA_API_KEY !== undefined
      ? runSessionWatchdogLoop(
          pool,
          {
            wahaBaseUrl: env.WAHA_API_BASE_URL,
            wahaApiKey: env.WAHA_API_KEY,
            intervalMs: env.WATCHDOG_INTERVAL_MS,
            redriveMinAgeMs: env.WATCHDOG_REDRIVE_MIN_AGE_MS,
            redriveBatchSize: env.WATCHDOG_REDRIVE_BATCH_SIZE,
            redriveSpacingMs: env.WATCHDOG_REDRIVE_SPACING_MS,
          },
          log,
          loopsAbort.signal,
        )
      : (log.warn('watchdog de sessão OFF — WAHA_API_BASE_URL/WAHA_API_KEY ausentes no env', {}),
        Promise.resolve());

  // Circuito de saúde do número (block/response rate → hold).
  const healthLoop = runHealthLoop(
    pool,
    { intervalMs: env.NUMBER_HEALTH_INTERVAL_MS },
    log,
    loopsAbort.signal,
  );

  // Flywheel agendado (4B): judge→distiller periódico sobre turnos reais.
  // Precisa da camada LLM; sem intervalo (0) fica OFF.
  const flywheelLoop =
    env.FLYWHEEL_INTERVAL_MS > 0
      ? runFlywheelLoop(
          pool,
          llmEdgeConfigFromEnv(env),
          { intervalMs: env.FLYWHEEL_INTERVAL_MS, limit: env.FLYWHEEL_BATCH_LIMIT, log },
          loopsAbort.signal,
        )
      : Promise.resolve();

  // Cron persistente por contato (follow-up) — só enfileira em job_queue.
  const cronLoop = runCronLoop(
    pool,
    {
      intervalMs: env.CRON_TICK_INTERVAL_MS,
      batchSize: env.CRON_BATCH_SIZE,
      staggerWindowMs: env.CRON_STAGGER_WINDOW_MS,
      retryBaseMs: env.CRON_RETRY_BASE_MS,
    },
    log,
    loopsAbort.signal,
  );

  const cacheAlertKnobs: CacheAlertKnobs = {
    windowMs: env.METRICS_WINDOW_MS,
    cacheHitAlertThreshold: env.CACHE_HIT_ALERT_THRESHOLD,
    cacheHitAlertMinRuns: env.CACHE_HIT_ALERT_MIN_RUNS,
  };

  const runJob = async (job: JobRow): Promise<void> => {
    try {
      const handler = handlers.get(job.kind);
      if (!handler) {
        throw new Error(`nenhum handler registrado para kind=${job.kind}`);
      }
      await handler(job, pool, { workerId });
      await completeJob(pool, job.id, workerId);
      log.info('job concluído', { job_id: job.id, kind: job.kind });
      try {
        const wrote = await recordRunMetrics(pool, job);
        if (wrote > 0) {
          await evaluateCacheHitAlert(pool, job.organization_id, cacheAlertKnobs);
        }
      } catch (metricsErr) {
        log.error('métricas do run não registradas', { job_id: job.id, error: errMsg(metricsErr) });
      }
    } catch (err) {
      log.error('job falhou', { job_id: job.id, kind: job.kind, error: errMsg(err) });
      try {
        await failJob(pool, job.id, workerId, err);
      } catch (failErr) {
        log.error('failJob indisponível — lease expira via reaper', {
          job_id: job.id,
          error: errMsg(failErr),
        });
      }
    }
  };

  const workerLoop = (async () => {
    while (!shuttingDown) {
      let claimed: JobRow[] = [];
      try {
        claimed = await claimJobs(pool, { workerId, maxConcurrency: env.QUEUE_MAX_CONCURRENCY });
      } catch (err) {
        log.error('claim falhou', { error: errMsg(err) });
      }
      for (const job of claimed) {
        const running = runJob(job);
        inFlight.add(running);
        void running.finally(() => inFlight.delete(running));
      }
      if (claimed.length === 0 || shuttingDown) {
        await sleep(env.QUEUE_POLL_INTERVAL_MS);
      }
    }
  })();

  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('sinal recebido — parando de claimar e drenando jobs em curso', {
      signal,
      in_flight: inFlight.size,
    });
    clearInterval(reaperTimer);
    clearInterval(holdsTimer);
    server.close();
    server.closeIdleConnections();
    loopsAbort.abort();
    await Promise.all([drainLoop, healthLoop, cronLoop, sessionWatchdogLoop, flywheelLoop]);
    await workerLoop;
    let graceTimer: NodeJS.Timeout | undefined;
    const grace = new Promise<'grace'>((resolve) => {
      graceTimer = setTimeout(() => resolve('grace'), env.SHUTDOWN_GRACE_MS);
    });
    const outcome = await Promise.race([
      Promise.all([...inFlight]).then(() => 'drained' as const),
      grace,
    ]);
    clearTimeout(graceTimer);
    if (outcome === 'grace') {
      log.error('shutdown: jobs em curso não drenaram no prazo — saindo sem esperar', {
        grace_ms: env.SHUTDOWN_GRACE_MS,
        in_flight: inFlight.size,
      });
      process.exit(1);
    }
    await pool.end();
    log.info('worker encerrado limpo', {});
    resolveStopped();
  };
  process.once('SIGTERM', (signal) => void shutdown(signal));
  process.once('SIGINT', (signal) => void shutdown(signal));

  // A linha que a Fase 0 exige ver: worker conectado ao Supabase, schema ok, pronto.
  log.info('agent-engine pronto', {
    worker_id: workerId,
    healthz_port: port,
    max_concurrency: env.QUEUE_MAX_CONCURRENCY,
  });
  await stopped;
}

export async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger();
  const handlers = new Map<JobKind, JobHandler>();
  const turnDeps: InboundTurnDeps = {
    crmCfg: crmEdgeConfigFromEnv({
      SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    }),
    llmCfg: llmEdgeConfigFromEnv(env),
    knobs: {
      historyLimit: env.LEAD_CONTEXT_HISTORY_LIMIT,
      maxContextTokens: env.LEAD_CONTEXT_MAX_TOKENS,
      notesIndexMaxTokens: env.LEAD_NOTES_INDEX_MAX_TOKENS,
      maxSteps: env.AGENT_MAX_STEPS,
      queuedRetryDelayMs: env.SEND_QUEUED_RETRY_MS,
      breaker: {
        exactFailureWarn: env.TOOL_BREAKER_EXACT_WARN,
        exactFailureBlock: env.TOOL_BREAKER_EXACT_BLOCK,
        sameToolFailureWarn: env.TOOL_BREAKER_SAME_TOOL_WARN,
        sameToolFailureHalt: env.TOOL_BREAKER_SAME_TOOL_HALT,
        noProgressWarn: env.TOOL_BREAKER_NO_PROGRESS_WARN,
        noProgressBlock: env.TOOL_BREAKER_NO_PROGRESS_BLOCK,
      },
      followup: {
        minAheadMs: env.FOLLOWUP_MIN_AHEAD_MS,
        maxAheadMs: env.FOLLOWUP_MAX_AHEAD_MS,
        staggerWindowMs: env.CRON_STAGGER_WINDOW_MS,
      },
      compaction: {
        triggerMessages: env.COMPACTION_TRIGGER_MESSAGES,
        ...(env.COMPACTION_MODEL !== undefined ? { model: env.COMPACTION_MODEL } : {}),
        transcriptMaxTokens: env.COMPACTION_TRANSCRIPT_MAX_TOKENS,
      },
      prune: {
        windowTurns: env.PRUNE_TOOL_RESULTS_WINDOW_TURNS,
        minResultTokens: env.PRUNE_TOOL_RESULTS_MIN_RESULT_TOKENS,
      },
      goldenCandidatesDir: env.GOLDEN_CANDIDATES_DIR,
      stageClassifier: {
        ...(env.STAGE_CLASSIFIER_MODEL !== undefined ? { model: env.STAGE_CLASSIFIER_MODEL } : {}),
      },
      jailbreak: {
        ...(env.JAILBREAK_CLASSIFIER_MODEL !== undefined ? { model: env.JAILBREAK_CLASSIFIER_MODEL } : {}),
      },
      disclosureMode: env.DISCLOSURE_MODE,
      promiseSemantic: {
        enabled: env.PROMISE_SEMANTIC_ENABLED,
        ...(env.PROMISE_SEMANTIC_MODEL !== undefined ? { model: env.PROMISE_SEMANTIC_MODEL } : {}),
      },
    },
    log,
  };
  handlers.set('inbound_turn', createInboundTurnHandler(turnDeps));
  handlers.set('followup_turn', createFollowupTurnHandler(turnDeps));
  await startWorker(env, handlers, log);
}

// tsx roda este arquivo como entrypoint direto.
main().catch((err: unknown) => {
  process.stderr.write(`boot falhou: ${errMsg(err)}\n`);
  process.exit(1);
});
