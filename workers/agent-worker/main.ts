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

// Sentry precisa iniciar antes de qualquer import de lógica de negócio: os
// imports abaixo são avaliados em ordem textual, e cada `import` só avança
// para o próximo depois de o módulo importado terminar de rodar — então
// colocar o `Sentry.init` aqui (antes dos imports do agent-engine) garante
// que ele está de pé antes de qualquer código do worker executar.
//
// Mesma lógica de `sentry.server.config.ts`/`sentry.edge.config.ts`
// (reaproveitada, não duplicada): DSN resolvido por `resolveSentryDsn`,
// amostragem de trace condicionada ao Sentry da comunidade via
// `isCommunityDsn` (issue #100), e os hooks de scrub de `lib/sentry/scrub.ts`.
// O `@sentry/nextjs` funciona fora do Next — aqui é só `Sentry.init` puro,
// sem `instrumentation.ts` porque o worker não é um processo Next.
import * as Sentry from '@sentry/nextjs';
import { resolveSentryDsn, isCommunityDsn, DEFAULT_SENTRY_DSN } from '@/lib/sentry/dsn';
import { sentryScrubHooks } from '@/lib/sentry/scrub';

const sentryDsn = resolveSentryDsn(process.env.SENTRY_DSN);
const sentryCommunity = isCommunityDsn(sentryDsn);

Sentry.init({
  dsn: sentryDsn,

  // No Sentry da comunidade, só erro (issue #100). Ver isCommunityDsn().
  tracesSampleRate: sentryCommunity ? 0 : 1,
  enableLogs: true,
  sendDefaultPii: false,

  ...sentryScrubHooks,
});

// Transparência de telemetria (mesma mensagem de sentry.server.config.ts,
// adaptada para o processo worker): uma linha no boot dizendo o que está
// ativo e como desligar.
if (!sentryDsn) {
  console.info('[telemetria] worker: Desligada (SENTRY_DSN=off) — nenhum erro é enviado.');
} else if (sentryDsn === DEFAULT_SENTRY_DSN) {
  console.info(
    '[telemetria] worker: Relatórios de erro anonimizados ATIVOS (Sentry da comunidade). ' +
      'Sem rastreamento de performance nem replay de sessão. ' +
      'Desligue com SENTRY_DSN=off, ou envie pro seu com SENTRY_DSN=<seu-dsn>.',
  );
} else {
  console.info('[telemetria] worker: Erros sendo enviados ao Sentry configurado em SENTRY_DSN.');
}

import http from 'node:http';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import type pg from 'pg';

import { createInboundTurnHandler } from '@/lib/agent-engine/agent/inbound-turn';
import { createFollowupTurnHandler, type FollowupTurnDeps } from '@/lib/agent-engine/agent/followup-turn';
import { createCaseReplyTurnHandler } from '@/lib/agent-engine/agent/case-reply-turn';
import { createOperatorTurnHandler } from '@/lib/agent-engine/agent/operator-turn';
import { completeTurnForEnrollment, createPgAdminClient } from '@/lib/followup/turn-bridge';
import { seedPlatformPlaybook } from '@/lib/agent-engine/agent/playbook-seed';
import { runCronLoop } from '@/lib/agent-engine/cron/scheduler';
import { createPool } from '@/lib/agent-engine/db/pool';
import { runDrainLoop } from '@/lib/agent-engine/edge/crm/drain';
import { runEventLogDrainLoop } from '@/lib/event-log/drain-loop';
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
import { rodarLoopDaFila } from '@/lib/agent-engine/queue/loop';
import {
  cancelJob,
  claimJobs,
  completeJob,
  failJob,
  faltaParaOProximoJob,
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
 * VETO PERMANENTE DE NEGÓCIO × INCIDENTE DE SISTEMA — a fila precisa distinguir.
 *
 * O erro é lido pela PROPRIEDADE `terminal`, e não pela classe, porque o
 * contrato é da fila e não do seam que o produziu: quem sabe que "tentar de novo
 * daqui a um minuto dá o mesmo resultado" é quem lança. Hoje o único produtor é
 * `LlmBudgetExceededError` (`lib/agent-engine/edge/llm/run-model-call.ts`), que
 * declara a propriedade com a razão escrita ao lado.
 *
 * Sem esta distinção, um bloqueio por orçamento ia para `failJob`, que reagenda
 * até `max_attempts` (5) e então insere um `job_dead` **crítico por job, sem
 * dedup**: N conversas × 5 tentativas viravam N alertas críticos rotulados "Uma
 * tarefa do assistente falhou", afogando o único `budget_exceeded` — que é o
 * alerta que explica. O precedente está escrito no próprio `queue.ts`: "Caso
 * real desta VPS: 16 alertas críticos idênticos".
 *
 * ⚠️ ESTA DECISÃO SÓ É SEGURA PORQUE O TRABALHO NÃO FICA ÓRFÃO — e essa parte
 * mora em OUTRO arquivo, então ela é dita aqui com o escopo exato:
 *
 *   * `inbound_turn`, `followup_turn` e `case_reply_turn` passam por
 *     `runAgentTurn` (`lib/agent-engine/agent/inbound-turn.ts`), que envolve o
 *     turno INTEIRO em `comHandoffSeOrcamentoAcabar`. Qualquer chamada de modelo
 *     do turno — inclusive as indiretas (`classifyStage`, `maybeCompact`), que
 *     rodam ANTES da principal — cai na escolta, e a conversa é devolvida à fila
 *     humana antes do relance. Nesses três, o job termina porque OUTRA PESSOA
 *     assumiu, não porque foi descartado. (A versão anterior desta frase era
 *     falsa: a escolta cobria só as duas chamadas diretas, o classificador
 *     estourava primeiro, e este `cancelJob` descartava o job com o lead no
 *     vácuo — a frase falsa era a justificativa da decisão irreversível.)
 *   * `operator_turn` NÃO tem handoff, e não deve ter: o lead já foi respondido
 *     pelo Conversador, e o Operador é retaguarda. O que se perde ali é o
 *     `registrarDesfecho` daquele turno — perda real, limitada e sem conserto
 *     por retry (o teto continua estourado no minuto seguinte). O sinal que
 *     sobra é o `budget_exceeded` na Central, que é o alerta que explica.
 */
function ehVetoPermanenteDeNegocio(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { terminal?: unknown }).terminal === true;
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

  // Self-host limpo: sem ponteiro platform, TODO inbound_turn morre. O seed só
  // age quando não existe ponteiro nenhum (regra dura nº 10 — nunca move
  // ponteiro existente) e é concorrência-safe (advisory lock).
  const playbookSeed = await seedPlatformPlaybook(pool);
  if (playbookSeed === 'seeded') {
    log.info('playbook platform seedado no boot (primeiro boot do self-host)');
  }

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
  // jobs. Fase 0 (convergência, spec 2026-07-23): o drain liga SEMPRE — o
  // dispatcher nativo EPIC-13 foi aposentado, o engine é o único consumidor.
  if (env.AGENT_DISPATCH_CONSUMER === 'native') {
    log.warn('AGENT_DISPATCH_CONSUMER=native é OBSOLETO (Fase 0) — o drain do engine é o único consumidor; valor ignorado', {});
  }
  const drainLoop = runDrainLoop(
    pool,
    {
      batchSize: env.CRM_DRAIN_BATCH_SIZE,
      intervalMs: env.CRM_DRAIN_INTERVAL_MS,
      idleIntervalMs: env.CRM_DRAIN_IDLE_INTERVAL_MS,
      debounceMs: env.INBOUND_DEBOUNCE_MS,
      reapTimeoutMs: env.CRM_EVENT_REAP_TIMEOUT_MS,
      allowlistTtlMs: env.AI_ALLOWLIST_TTL_DAYS * 24 * 60 * 60 * 1000,
    },
    log,
    loopsAbort.signal,
  );

  // Handlers do event_log (mídia, branding, follow-up…) no ritmo do worker.
  // Antes disto eles só rodavam pelo cron `event-log-drain`, 1×/min: a cadeia
  // persist→derive de um áudio levava 103-188s contra os 45s que o drain do
  // turno espera, e o agente respondia "não consigo ouvir" com a transcrição
  // pronta segundos depois. O cron continua como rede de segurança — o claim
  // otimista do `drainEventLog` torna os dois seguros em paralelo.
  const eventLogLoop = runEventLogDrainLoop(
    {
      intervalMs: env.EVENT_LOG_DRAIN_INTERVAL_MS,
      idleIntervalMs: env.EVENT_LOG_DRAIN_IDLE_INTERVAL_MS,
      batchSize: env.EVENT_LOG_DRAIN_BATCH_SIZE,
    },
    log,
    loopsAbort.signal,
  );

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
      const terminal = ehVetoPermanenteDeNegocio(err);
      // `warn`, não `error`: veto de negócio é o sistema funcionando como
      // configurado. Rotulá-lo de erro treina quem opera a ignorar o painel.
      if (terminal) {
        log.warn('job cancelado por veto permanente de negócio', {
          job_id: job.id,
          kind: job.kind,
          error: errMsg(err),
        });
      } else {
        log.error('job falhou', { job_id: job.id, kind: job.kind, error: errMsg(err) });
        // Só o caminho não-terminal: veto de negócio (acima) é o sistema
        // funcionando como configurado, não um incidente — mandar isso pro
        // Sentry afogaria o painel com o mesmo ruído que `ehVetoPermanenteDeNegocio`
        // existe para evitar (ver comentário da função, "16 alertas críticos
        // idênticos"). Isto aqui é falha real e não tratada do turno/job.
        Sentry.captureException(err);
      }
      try {
        if (terminal) {
          await cancelJob(pool, job.id, workerId, errMsg(err));
        } else {
          await failJob(pool, job.id, workerId, err);
        }
      } catch (failErr) {
        log.error('disposição do job indisponível — lease expira via reaper', {
          job_id: job.id,
          error: errMsg(failErr),
        });
        // Falha dupla: o job falhou E a fila não conseguiu registrar a falha
        // (banco fora do ar, tipicamente). O job só se recupera pelo reaper —
        // vale saber que isto aconteceu.
        Sentry.captureException(failErr);
      }
    }
  };

  const workerLoop = rodarLoopDaFila<JobRow>({
    relogio: () => faltaParaOProximoJob(pool),
    claimar: () => claimJobs(pool, { workerId, maxConcurrency: env.QUEUE_MAX_CONCURRENCY }),
    aoClaimar: (jobs) => {
      for (const job of jobs) {
        const running = runJob(job);
        inFlight.add(running);
        void running.finally(() => inFlight.delete(running));
      }
    },
    // O `{ signal }` é o que faz o `docker stop` não esperar a espera inteira —
    // e é por isso que `rodarLoopDaFila` trata a rejeição em vez de propagá-la:
    // `sleep` abortado REJEITA, e essa rejeição chegaria ao `await workerLoop`
    // logo abaixo, matando o processo antes do drain dos jobs em voo.
    dormir: (ms) => sleep(ms, undefined, { signal: loopsAbort.signal }),
    deveParar: () => shuttingDown,
    intervalos: { ociosoMs: env.QUEUE_POLL_INTERVAL_MS, retryMs: env.QUEUE_CLAIM_RETRY_INTERVAL_MS },
    log,
  });

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
    await Promise.all([drainLoop, eventLogLoop, healthLoop, cronLoop, sessionWatchdogLoop, flywheelLoop]);
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
  // Os dois intervalos vão junto porque governam a conta de egress do banco (issue
  // #258) e quem os ajusta precisa conseguir CONFERIR o que está em vigor sem ler
  // o código-fonte — foi o que o autor da issue teve de fazer para achar o knob.
  log.info('agent-engine pronto', {
    worker_id: workerId,
    healthz_port: port,
    max_concurrency: env.QUEUE_MAX_CONCURRENCY,
    poll_ocioso_ms: env.QUEUE_POLL_INTERVAL_MS,
    claim_retry_ms: env.QUEUE_CLAIM_RETRY_INTERVAL_MS,
  });
  // Acima de 10 s a espera ociosa passa do idleTimeoutMillis do pool (10 s, o
  // default do pg): a conexão morre entre uma rodada e outra, e cada consulta ao
  // relógio volta a pagar TCP+TLS+startup. Medido: 499 B por rodada depois de 12 s
  // de sono contra 66 B depois de 2 s — subir o intervalo além daí gasta mais do
  // que economiza. Aviso em vez de teto no schema: um `.max()` faria o worker
  // RECUSAR subir numa máquina cujo .env já tem um valor maior, e a doutrina de
  // packaging proíbe atualização que exija edição manual de arquivo.
  if (env.QUEUE_POLL_INTERVAL_MS >= 10_000) {
    log.warn('QUEUE_POLL_INTERVAL_MS ≥ 10s — cada rodada ociosa reconecta ao banco e gasta MAIS que um valor menor', {
      poll_ocioso_ms: env.QUEUE_POLL_INTERVAL_MS,
    });
  }
  await stopped;
}

export async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger();
  const handlers = new Map<JobKind, JobHandler>();
  const turnDeps: FollowupTurnDeps = {
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
      maxSendsPerTurn: env.MAX_SENDS_PER_TURN,
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
      followupAi: {
        ...(env.FOLLOWUP_AI_MODEL !== undefined ? { model: env.FOLLOWUP_AI_MODEL } : {}),
      },
      allowlistTtlMs: env.AI_ALLOWLIST_TTL_DAYS * 24 * 60 * 60 * 1000,
    },
    log,
    // Onda 5 (Task 5.1): fecha o turno dirigido por fluxo de volta no enrollment —
    // o worker fala pg puro (nunca Supabase client), então usa o adapter pg de
    // lib/followup/turn-bridge.ts (equivalente ao createSupabaseAdminClient das
    // rotas Next.js, mas pra este processo).
    completeFollowupTurn: (pool, { organizationId, enrollmentId, nodeId, result }) =>
      completeTurnForEnrollment(createPgAdminClient(pool), organizationId, enrollmentId, nodeId, result),
  };
  handlers.set('inbound_turn', createInboundTurnHandler(turnDeps));
  handlers.set('followup_turn', createFollowupTurnHandler(turnDeps));
  handlers.set('case_reply_turn', createCaseReplyTurnHandler(turnDeps));
  // Spec 16 §3.2 — o papel OPERADOR. Registrado sempre; quem decide se ele age é
  // `operator_enabled` na versão publicada (default false), lido a cada job. Um
  // worker que não conhecesse o kind faria os jobs morrerem em 'dead' sem que
  // ninguém entendesse por quê.
  handlers.set('operator_turn', createOperatorTurnHandler(turnDeps));
  await startWorker(env, handlers, log);
}

// tsx roda este arquivo como entrypoint direto.
main().catch((err: unknown) => {
  process.stderr.write(`boot falhou: ${errMsg(err)}\n`);
  Sentry.captureException(err);
  // `captureException` só enfileira — sem o flush, o `process.exit` teria boa
  // chance de matar o processo antes do envio sair (é exatamente o cenário:
  // boot falhou, o processo já está de saída). 2s é o mesmo teto usado pelo
  // `SHUTDOWN_GRACE_MS` default deste worker para não pendurar o exit.
  void Sentry.flush(2000).finally(() => process.exit(1));
});
