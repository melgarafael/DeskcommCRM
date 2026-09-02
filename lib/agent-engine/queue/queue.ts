/**
 * Fila durável no Postgres do harness — FOR UPDATE SKIP LOCKED com lane por contact_id
 * (F2-03; stack.md §3, blueprint 8.6). Primitivas puras: enqueue, claim, complete,
 * fail e reaper. O worker-loop de produção chega na F2-04.
 *
 * Claim em DUAS etapas (stack.md §3 "Claim da fila"):
 *   a) dedup por lane DENTRO do lote via DISTINCT ON — sem isso, 2 jobs pending do
 *      MESMO lead no mesmo lote violariam a unique parcial e o 23505 abortaria o
 *      lote INTEIRO (starvation no hot path);
 *   b) FOR UPDATE SKIP LOCKED + UPDATE para 'running' (attempts incrementa AQUI).
 * O índice parcial uniq_job_queue_one_running_per_contact fica de CINTO: na corrida
 * residual entre workers o 23505 é capturado e o claim perde só a rodada.
 *
 * Sem imports de RUNTIME de propósito: o worker de teste do SIGKILL roda este
 * módulo direto no Node 22 (type stripping), que não resolve especificador .js→.ts.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

export type JobKind = 'inbound_turn' | 'followup_turn' | 'watchdog' | 'flywheel' | 'case_reply_turn' | 'operator_turn';
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'dead';

export interface JobRow {
  id: string;
  organization_id: string;
  contact_id: string | null;
  kind: JobKind;
  source_event_id: string | null;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  run_after: Date;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  locked_by: string | null;
  locked_at: Date | null;
  created_at: Date;
}

/**
 * Superfície mínima comum a pg.Pool e pg.PoolClient — é o que permite enfileirar o
 * PRÓXIMO evento dentro da transação do complete (mesmo commit, blueprint 8.6).
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

// Serializa claimers (vizinho do lock do migrate, 727257): contar 'running' +
// reservar capacidade vira atômico — o cap global nunca é excedido por corrida.
const CLAIM_LOCK_KEY = 727258;

export interface EnqueueInput {
  kind: JobKind;
  leadId?: string | null;
  sourceEventId?: string | null;
  payload?: Record<string, unknown>;
  priority?: number;
  runAfter?: Date;
  maxAttempts?: number;
}

/**
 * Insere um job. `sourceEventId` deduplica evento→job (unique parcial + captura de
 * 23505): re-entrega at-least-once devolve a MESMA linha com `deduped: true`.
 */
export async function enqueueJob(
  db: Queryable,
  tenantId: string,
  input: EnqueueInput,
): Promise<{ job: JobRow; deduped: boolean }> {
  try {
    const { rows } = await db.query<JobRow>(
      `insert into job_queue
         (organization_id, contact_id, kind, source_event_id, payload, priority, run_after, max_attempts)
       values
         ($1, $2, $3, $4, $5,
          coalesce($6::smallint, 100),      -- espelham os defaults do DDL (0002)
          coalesce($7::timestamptz, now()),
          coalesce($8::smallint, 5))
       returning *`,
      [
        tenantId,
        input.leadId ?? null,
        input.kind,
        input.sourceEventId ?? null,
        input.payload ?? {},
        input.priority ?? null,
        input.runAfter ?? null,
        input.maxAttempts ?? null,
      ],
    );
    return { job: mustRow(rows, 'job_queue insert'), deduped: false };
  } catch (err) {
    if (!isUniqueViolation(err) || input.sourceEventId == null) {
      throw err;
    }
    const { rows } = await db.query<JobRow>(
      'select * from job_queue where organization_id = $1 and source_event_id = $2',
      [tenantId, input.sourceEventId],
    );
    return { job: mustRow(rows, 'job_queue dedup'), deduped: true };
  }
}

export interface ClaimOptions {
  workerId: string;
  /** Cap GLOBAL de jobs 'running' simultâneos — knob QUEUE_MAX_CONCURRENCY (env.ts), nunca constante. */
  maxConcurrency: number;
  /** Máximo de jobs por rodada de claim (default: o próprio maxConcurrency). */
  batchSize?: number;
}

const CLAIM_SQL = `
  with dedup as (
    -- etapa (a): no máximo 1 job por lane por lote; lane sem lead = o próprio id
    select distinct on (coalesce(j.contact_id, j.id)) j.id
    from job_queue j
    where j.status = 'pending' and j.run_after <= now()
      and (j.contact_id is null
           or not exists (select 1 from job_queue r
                          where r.contact_id = j.contact_id and r.status = 'running'))
    order by coalesce(j.contact_id, j.id), j.priority, j.run_after
  ),
  runnable as (
    -- etapa (b): lock sem bloquear ninguém
    select j.id from job_queue j
    join dedup d on d.id = j.id
    where j.status = 'pending'
    order by j.priority, j.run_after
    limit $1
    for update of j skip locked
  )
  update job_queue
  set status = 'running', locked_by = $2, locked_at = now(), attempts = attempts + 1
  where id in (select id from runnable)
  returning *`;

/**
 * Claima até `batchSize` jobs respeitando o cap global (`maxConcurrency`): a soma de
 * jobs 'running' no banco nunca passa do cap. O advisory xact lock serializa só o
 * claim (milissegundos), nunca o processamento — e por contar no banco vale até para
 * N processos no MESMO Postgres (o worker de teste do SIGKILL usa isso).
 * ponytail: cap é do daemon único; se um dia houver N daemons em bancos separados,
 * vira knob agregado por daemon.
 */
/**
 * Quantos MILISSEGUNDOS faltam até o próximo job ficar claimável — `null` quando
 * não há nenhum `pending`. É o relógio que o loop consulta ANTES de abrir o claim.
 *
 * Um `select` só, sem `connect`, sem `begin` e sem advisory lock: o claim custa 5
 * statements e 638 B de egress por rodada (medido no protocolo, fila vazia), e
 * numa instalação ociosa ele rodava 4×/s para sempre — a issue #258. Este aqui
 * custa 1 statement e 54 B, e é servido por `idx_job_queue_claim` (o parcial de
 * `status='pending'` que já existe): Index Only Scan, 1 buffer, 0,010 ms medidos
 * com 50 mil linhas na tabela — não degrada com o histórico.
 *
 * A garantia não é "o claim nunca perde um job por causa desta leitura". Ela é
 * MAIS FRACA e é a verdadeira: como a leitura é uma FOTO (o `now()` dela é o
 * instante da própria transação), um job que vence entre a foto e o despertar
 * fica esperando — mas só até a próxima foto, porque nada no produto tira uma
 * linha de `pending`+vencida. Ou seja: **a foto nunca esconde um job por mais de
 * um `QUEUE_POLL_INTERVAL_MS`**. Medido: 1.300 estados de fronteira em fuzz
 * diferencial contra o `claimJobs` real, zero casos de job escondido.
 *
 * Três armadilhas, todas com caso em tests/invariants/queue-relogio.test.ts:
 *   - o `case when` é OBRIGATÓRIO: `greatest(NULL, 0)` no Postgres devolve 0, não
 *     NULL — sem ele a fila VAZIA se disfarçaria de "job vencido" e o loop
 *     voltaria a girar no ritmo curto, que é exatamente o defeito da issue;
 *   - o clamp segura `run_after = 'infinity'`, que o hold do session-watchdog
 *     grava (`session-watchdog.ts`), e que estouraria o `int4` do cast. Ele
 *     clampa o TIMESTAMP, e não o resultado, e a ordem NÃO é estilo: em
 *     Postgres 15 e 16 `'infinity'::timestamptz - now()` é um ERRO do servidor
 *     (`cannot subtract infinite timestamps`), então um `least()` aplicado ao
 *     resultado nunca chega a rodar. Medido nos dois: pg15 devolve o erro,
 *     pg17 devolve `infinity`. Enquanto o piso declarado era pg17 isto era
 *     latente; num Postgres 15 quebra o RELÓGIO do worker
 *     (`workers/agent-worker/main.ts`), que é quem chama esta função.
 *     Guardado por `tests/unit/aritmetica-de-timestamp-infinito.test.ts`;
 *   - o `::int` faz o pg devolver `number`; sem ele viria `string` de `numeric`.
 */
export async function faltaParaOProximoJob(pool: Pool): Promise<number | null> {
  const { rows } = await pool.query<{ falta_ms: number | null }>(
    `select case
              when min(run_after) is null then null
              -- O clamp é do TIMESTAMP, não do resultado — e a ordem é o
              -- conserto. Ver o parágrafo do 'infinity' no cabeçalho: em
              -- Postgres 15 a SUBTRAÇÃO estoura antes de qualquer least()
              -- ('cannot subtract infinite timestamps'), então clampar depois
              -- protege só quem já está no 17.
              else greatest(
                     extract(epoch from (
                       least(min(run_after), now() + interval '1 day') - now()
                     )) * 1000,
                     0
                   )::int
            end as falta_ms
       from job_queue
      where status = 'pending'`,
  );
  return rows[0]?.falta_ms ?? null;
}

export async function claimJobs(pool: Pool, opts: ClaimOptions): Promise<JobRow[]> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock($1)', [CLAIM_LOCK_KEY]);
    const running = await client.query<{ n: number }>(
      `select count(*)::int as n from job_queue where status = 'running'`,
    );
    const free = Math.min(
      opts.batchSize ?? opts.maxConcurrency,
      opts.maxConcurrency - (running.rows[0]?.n ?? 0),
    );
    if (free <= 0) {
      await client.query('rollback');
      return [];
    }
    const { rows } = await client.query<JobRow>(CLAIM_SQL, [free, opts.workerId]);
    await client.query('commit');
    return rows;
  } catch (err) {
    await rollback(client, err);
    if (isUniqueViolation(err)) {
      return []; // cinto do índice parcial: corrida residual perde só a rodada
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Conclui o job DENTRO de uma transação e expõe o client dela: escrita de estado e
 * emissão do próximo evento acontecem no MESMO commit do complete (blueprint 8.6).
 * Se o lease foi perdido (reaper devolveu o job após visibility timeout e outro
 * worker o re-claimou), NADA é commitado — exactly-once de efeito.
 */
export async function completeJob<T = void>(
  pool: Pool,
  jobId: string,
  workerId: string,
  inSameCommit?: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = (inSameCommit ? await inSameCommit(client) : undefined) as T;
    const done = await client.query(
      `update job_queue set status = 'done', locked_by = null, locked_at = null
       where id = $1 and status = 'running' and locked_by = $2`,
      [jobId, workerId],
    );
    if (done.rowCount !== 1) {
      throw new Error(
        `lease do job ${jobId} perdido no complete (re-claim pós visibility timeout?) — efeitos descartados`,
      );
    }
    await client.query('commit');
    return result;
  } catch (err) {
    await rollback(client, err);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Devolve o job à fila após falha (attempts já foi incrementado no claim). Excedeu
 * `max_attempts` → 'dead' + escalação humana em agent_inbox_items (kind='job_dead'), no
 * MESMO statement (atômico). Devolve null se o lease já não era deste worker.
 *
 * Backoff exponencial no retry (10s, 20s, 40s, 80s, capado em 120s — chave em
 * `attempts`, já pós-incremento do claim): sem isso `run_after` fica intocado e
 * o job cai `pending` já vencido, então o próximo `claimJobs` (poll de poucos
 * segundos) o repega na hora. Contra um erro transitório de rate limit (TPM da
 * OpenAI, por ex.) isso queima as 5 tentativas em menos de 1s — o rate limit não
 * teve NENHUM tempo pra ceder entre uma tentativa e outra, e o job morre por um
 * incidente que um minuto de espera resolveria sozinho. Caso real desta VPS,
 * 2026-08-31: 49 jobs mortos em rajadas de poucos segundos, todos por TPM.
 */
export async function failJob(
  db: Queryable,
  jobId: string,
  workerId: string,
  error: unknown,
): Promise<JobRow | null> {
  const { rows } = await db.query<JobRow>(
    `with updated as (
       update job_queue
       set status = case when attempts >= max_attempts then 'dead' else 'pending' end,
           run_after = case
             when attempts >= max_attempts then run_after
             else now() + (least(power(2, greatest(attempts - 1, 0)) * 10, 120) * interval '1 second')
           end,
           locked_by = null, locked_at = null, last_error = $3
       where id = $1 and status = 'running' and locked_by = $2
       returning *
     ),
     alert as (
       insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
       select organization_id, 'job_dead', 'critical',
              'Job descartado após esgotar tentativas',
              -- O erro que matou o job vai JUNTO. Antes o corpo era só
              -- 'kind=...; attempts=5' e jogava fora a única informação que
              -- resolveria: o aviso existia, e não dizia nada. Caso real desta
              -- VPS: 16 alertas críticos idênticos enquanto o erro guardado em
              -- last_error dizia exatamente o que configurar.
              'kind=' || kind || '; attempts=' || attempts
                || coalesce(chr(10) || 'Motivo: ' || left(last_error, 400), ''),
              'job_queue', id
       from updated
       where status = 'dead'
     )
     select * from updated`,
    [jobId, workerId, normalizeError(error)],
  );
  return rows[0] ?? null;
}

/**
 * Cancela o job em definitivo (status 'failed', terminal) — veto PERMANENTE de
 * negócio (ex.: 403 is_blocked no sink, F2-06): não é incidente de sistema, então
 * nem retry nem 'dead' + alerta crítico (seria ruído de inbox para um opt-out).
 * A razão fica em last_error (normalizada — nunca conteúdo de mensagem).
 * Devolve null se o lease já não era deste worker.
 */
export async function cancelJob(
  db: Queryable,
  jobId: string,
  workerId: string,
  reason: string,
): Promise<JobRow | null> {
  const { rows } = await db.query<JobRow>(
    `update job_queue
     set status = 'failed', locked_by = null, locked_at = null, last_error = $3
     where id = $1 and status = 'running' and locked_by = $2
     returning *`,
    [jobId, workerId, normalizeError(reason)],
  );
  return rows[0] ?? null;
}

/**
 * Devolve o job a 'pending' com run_after adiado SEM consumir attempts (desfaz o
 * incremento do claim): espera de SESSÃO (resposta 'queued' do CRM, F2-06) não é
 * falha do job — sessão fora por horas não pode matar mensagem de lead saudável.
 * Devolve null se o lease já não era deste worker.
 */
export async function rescheduleJob(
  db: Queryable,
  jobId: string,
  workerId: string,
  opts: { delayMs: number; reason: string },
): Promise<JobRow | null> {
  const { rows } = await db.query<JobRow>(
    `update job_queue
     set status = 'pending', locked_by = null, locked_at = null,
         run_after = now() + ($3 * interval '1 millisecond'),
         attempts = greatest(attempts - 1, 0),
         last_error = $4
     where id = $1 and status = 'running' and locked_by = $2
     returning *`,
    [jobId, workerId, opts.delayMs, normalizeError(opts.reason)],
  );
  return rows[0] ?? null;
}

/**
 * Reaper do visibility timeout: job 'running' com locked_at mais velho que o timeout
 * é de um worker morto — volta a 'pending' (re-claim) ou, se já esgotou max_attempts,
 * vira 'dead' + agent_inbox_items. Timeout é knob (QUEUE_VISIBILITY_TIMEOUT_MS, env.ts).
 */
export async function reapExpiredJobs(
  db: Queryable,
  opts: { visibilityTimeoutMs: number },
): Promise<{ revived: number; dead: number }> {
  const { rows } = await db.query<{ id: string; status: JobStatus }>(
    `with expired as (
       update job_queue
       set status = case when attempts >= max_attempts then 'dead' else 'pending' end,
           locked_by = null, locked_at = null,
           last_error = coalesce(last_error, 'visibility timeout excedido (worker morto?)')
       where status = 'running' and locked_at < now() - ($1 * interval '1 millisecond')
       -- last_error PRECISA sair no returning: a CTE do alerta abaixo só
       -- enxerga as colunas devolvidas aqui, não as da tabela. Faltando ela, a
       -- query inteira morre com "column last_error does not exist" — e como
       -- este reap roda no BOOT do worker, o worker não subia.
       returning id, organization_id, kind, attempts, status, last_error
     ),
     alert as (
       insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
       select organization_id, 'job_dead', 'critical',
              'Job descartado após esgotar tentativas',
              -- O erro que matou o job vai JUNTO. Antes o corpo era só
              -- 'kind=...; attempts=5' e jogava fora a única informação que
              -- resolveria: o aviso existia, e não dizia nada. Caso real desta
              -- VPS: 16 alertas críticos idênticos enquanto o erro guardado em
              -- last_error dizia exatamente o que configurar.
              'kind=' || kind || '; attempts=' || attempts
                || coalesce(chr(10) || 'Motivo: ' || left(last_error, 400), ''),
              'job_queue', id
       from expired
       where status = 'dead'
     )
     select id, status from expired`,
    [opts.visibilityTimeoutMs],
  );
  return {
    revived: rows.filter((r) => r.status === 'pending').length,
    dead: rows.filter((r) => r.status === 'dead').length,
  };
}

/**
 * PII fora do banco de erro: last_error guarda SÓ a 1ª linha da mensagem, truncada —
 * nunca conteúdo de mensagem de lead (que erros de handler podem carregar no corpo).
 */
function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split('\n', 1)[0] ?? '').slice(0, 300);
}

function mustRow<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`esperava uma linha de ${what}, veio nenhuma`);
  }
  return row;
}

async function rollback(client: PoolClient, cause: unknown): Promise<void> {
  try {
    await client.query('rollback');
  } catch (rollbackErr) {
    throw new AggregateError([cause, rollbackErr], 'rollback falhou após erro na transação da fila');
  }
}

// Predicado local de propósito: este módulo fica sem imports de runtime para
// rodar direto no Node 22 — ver cabeçalho.
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}
