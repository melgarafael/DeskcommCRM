/**
 * Observabilidade v1 (F2-16; blueprint 8.3) — métricas de 1ª classe persistidas
 * na tabela `metrics` (0009) + snapshot agregado servido em GET /metrics (main.ts).
 *
 * Desenho:
 *   - coleta por RUN no fechamento do job (main.ts, após completeJob): agrega as
 *     linhas que `llm_calls` (F2-23) JÁ grava por chamada — tokens, cache_read,
 *     custo, latência — em métricas `run_*` com labels só de ids (job_id = run id,
 *     lead_id, kind). "Por conversa" = agregação por labels->>'lead_id' (consulta,
 *     não escrita). PII NUNCA entra em name/labels;
 *   - cache_read_ratio = cache_read_tokens / input_tokens do run, contando SÓ as
 *     chamadas cacheáveis (entrada ≥ 1.024 tokens) — a métrica de 1ª classe do
 *     caching (CLAUDE.md regra 15). Alerta: quando a razão PONDERADA da janela
 *     recente fica abaixo do alvo com um mínimo de runs (nunca 1 item por run —
 *     antes da F2-17 o ratio é ~0 em todo run; os knobs controlam o disparo),
 *     insere inbox_items 1× por EPISÓDIO (dedup enquanto houver item aberto —
 *     mesmo padrão do budget_exceeded em run-model-call.ts). O texto do aviso traz
 *     o recorte por finalidade e provedor: a causa se mede, não se afirma;
 *   - /metrics expõe também profundidade da fila (job_queue), envios por status do
 *     ledger (F2-06 — 'vetoed' é o slot dos envios vetados; a cadeia de gates da
 *     F2-13 somará vetos aqui) e saúde de sessão (channel_session_health, F2-14).
 */
import type pg from 'pg';

import { sessionHealthMetrics, type SessionHealthMetric } from '../edge/crm/session-watchdog';
import type { JobRow, Queryable } from '../queue/queue';

/** nome da métrica de 1ª classe do caching — âncora do alerta e dos testes */
export const CACHE_RATIO_METRIC = 'run_cache_read_ratio';

/**
 * Menor entrada que o provedor guarda em cache. Abaixo disto a chamada NUNCA
 * cacheia (é o caso dos classificadores), então ela não pode entrar nem no
 * numerador nem no denominador da razão — somá-la afunda o número e faz o aviso
 * disparar sem que exista defeito de prefixo (#4362).
 */
export const CACHEABLE_INPUT_TOKENS_MIN = 1024;

/** espera do job na fila até o claim (inclui debounce) — ver recordRunMetrics */
export const QUEUE_WAIT_METRIC = 'run_queue_wait_ms';

/** duração do job do claim ao fechamento, no relógio do banco */
export const WALL_METRIC = 'run_wall_ms';

/** discriminador do episódio do alerta em inbox_items.ref_kind (kind é CHECK da 0001) */
export const CACHE_ALERT_REF_KIND = 'cache_hit_ratio';

/** Knobs do alerta de cache (env CACHE_HIT_ALERT_* / METRICS_WINDOW_MS) — nunca constantes. */
export interface CacheAlertKnobs {
  /** janela de agregação (também a janela do snapshot /metrics) */
  windowMs: number;
  /** média da janela abaixo disto → alerta (0..1; blueprint 8.3: 0.40) */
  cacheHitAlertThreshold: number;
  /** mínimo de runs na janela antes de alertar — evita alarme com amostra rasa */
  cacheHitAlertMinRuns: number;
}

/**
 * Agrega as llm_calls do run recém-fechado em métricas `run_*` e grava os dois
 * tempos do job. Devolve quantas chamadas de modelo o run teve (0 = o alerta de
 * cache não tem o que avaliar). `job` é a ROW da fila (fonte confiável de
 * tenant/lead — regra dura nº 1), nunca payload.
 *
 * Os tempos vêm do claim, e não de `job_queue.locked_at`: o done zera essa
 * coluna (queue.ts, completeJob), então depois do job ela não mede nada.
 *   - `run_queue_wait_ms` = claim − created_at. INCLUI o debounce (run_after
 *     nasce no futuro) e qualquer adiamento: é espera, não lentidão do worker;
 *     o runbook `docs/runbooks/medir-custo-e-latencia-da-ia.md` separa as parcelas.
 *   - `run_wall_ms` = agora − claim, no relógio do BANCO (o claim também é
 *     `now()` do banco): o relógio do worker não entra na subtração. Inclui o
 *     atraso humano deliberado antes da 1ª bolha.
 */
export async function recordRunMetrics(
  db: pg.Pool,
  job: Pick<JobRow, 'id' | 'organization_id' | 'contact_id' | 'kind' | 'created_at' | 'claim_acquired_at'>,
): Promise<number> {
  const { rows } = await db.query<{
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cacheable_calls: number;
    cacheable_input_tokens: number;
    cacheable_cache_read_tokens: number;
    cost_cents: number | null;
    llm_latency_ms: number;
  }>(
    // Os totais (custo, tokens, latência) são de TODAS as chamadas — é o que o run
    // gastou. A razão de cache, porém, só faz sentido sobre as chamadas cacheáveis:
    // o provedor não guarda prefixo abaixo de CACHEABLE_INPUT_TOKENS_MIN tokens de
    // entrada, então o classificador entraria no denominador sem chance de entrar
    // no numerador e afundaria a métrica sem defeito nenhum (#4362).
    `select count(*)::int as calls,
            coalesce(sum(input_tokens), 0)::float8 as input_tokens,
            coalesce(sum(output_tokens), 0)::float8 as output_tokens,
            coalesce(sum(cache_read_tokens), 0)::float8 as cache_read_tokens,
            count(*) filter (where input_tokens >= ${CACHEABLE_INPUT_TOKENS_MIN})::int as cacheable_calls,
            coalesce(sum(input_tokens) filter (where input_tokens >= ${CACHEABLE_INPUT_TOKENS_MIN}), 0)::float8
              as cacheable_input_tokens,
            coalesce(sum(cache_read_tokens) filter (where input_tokens >= ${CACHEABLE_INPUT_TOKENS_MIN}), 0)::float8
              as cacheable_cache_read_tokens,
            (sum(cost_cents))::float8 as cost_cents,
            coalesce(sum(latency_ms), 0)::float8 as llm_latency_ms
     from llm_calls
     where organization_id = $1 and job_id = $2`,
    [job.organization_id, job.id],
  );
  const agg = rows[0];
  const calls = agg?.calls ?? 0;
  const names: string[] = [];
  const values: number[] = [];
  const push = (name: string, value: number | null): void => {
    if (value !== null) {
      names.push(name);
      values.push(value);
    }
  };
  if (agg !== undefined && calls > 0) {
    push('run_llm_calls', agg.calls);
    push('run_input_tokens', agg.input_tokens);
    push('run_output_tokens', agg.output_tokens);
    push('run_cache_read_tokens', agg.cache_read_tokens);
    // Sem chamada cacheável não há razão a gravar: 0 mentiria "cache péssimo" para
    // um run que só fez classificação. O alerta e o /metrics média só enxergam runs
    // com alguma chamada cacheável.
    if (agg.cacheable_calls > 0) {
      push(
        CACHE_RATIO_METRIC,
        agg.cacheable_input_tokens > 0 ? agg.cacheable_cache_read_tokens / agg.cacheable_input_tokens : 0,
      );
    }
    // custo NULL = preço desconhecido (pricing.ts) — não gravar (0 mentiria "grátis")
    push('run_cost_cents', agg.cost_cents);
    // soma das latências das chamadas LLM do run (não wall time do job)
    push('run_llm_latency_ms', agg.llm_latency_ms);
  }
  const claim = job.claim_acquired_at ?? null;
  if (claim !== null) {
    push(QUEUE_WAIT_METRIC, Math.max(0, new Date(claim).getTime() - new Date(job.created_at).getTime()));
  }
  if (names.length === 0) {
    return calls;
  }

  // labels SÓ ids/atribuição (job_id É o run id) — PII jamais.
  // `$1::uuid` explícito: dentro de um UNION o Postgres resolve o parâmetro sem
  // tipo como `text` antes de olhar a coluna de destino, e o INSERT inteiro cai
  // (`organization_id is of type uuid but expression is of type text`). Provado
  // no banco real em `tests/invariants/metricas-do-run-gravam.test.ts`.
  const labels = { job_id: job.id, contact_id: job.contact_id, kind: job.kind };
  await db.query(
    `insert into metrics (organization_id, name, labels, value)
     select $1::uuid, t.name, $2::jsonb, t.value
     from unnest($3::text[], $4::float8[]) as t(name, value)
     union all
     select $1::uuid, '${WALL_METRIC}', $2::jsonb,
            greatest(0, extract(epoch from (clock_timestamp() - $5::timestamptz)) * 1000)
     where $5::timestamptz is not null`,
    [job.organization_id, JSON.stringify(labels), names, values, claim],
  );
  return calls;
}

export interface CacheAlertResult {
  /** runs (métricas de ratio) na janela */
  runs: number;
  /** razão cache_read/input das chamadas CACHEÁVEIS da janela — null sem amostra */
  avgRatio: number | null;
  /** true = inseriu inbox_item NESTA avaliação (episódio novo) */
  alerted: boolean;
}

/** uma linha do recorte: chamadas cacheáveis de uma finalidade num provedor */
interface RecorteDeCache {
  purpose: string;
  provider: string;
  calls: number;
  input_tokens: number;
  cache_read_tokens: number;
}

interface RecorteAgregado {
  nome: string;
  calls: number;
  input_tokens: number;
  cache_read_tokens: number;
}

const emPorcento = (cacheRead: number, input: number): string =>
  `${(input > 0 ? (cacheRead / input) * 100 : 0).toFixed(1)}%`;

/** soma as linhas (purpose × provider) numa chave só, da maior entrada para a menor */
function agregaPor(linhas: RecorteDeCache[], chave: 'purpose' | 'provider'): RecorteAgregado[] {
  const mapa = new Map<string, RecorteAgregado>();
  for (const linha of linhas) {
    const nome = linha[chave];
    const atual = mapa.get(nome) ?? { nome, calls: 0, input_tokens: 0, cache_read_tokens: 0 };
    atual.calls += linha.calls;
    atual.input_tokens += linha.input_tokens;
    atual.cache_read_tokens += linha.cache_read_tokens;
    mapa.set(nome, atual);
  }
  return [...mapa.values()].sort((a, b) => b.input_tokens - a.input_tokens);
}

/** "agent_turn 45.0% (10 chamadas) · checkpoint 0.2% (318 chamadas)" */
function descreveRecorte(recorte: RecorteAgregado[]): string {
  return recorte
    .map(
      (r) =>
        `${r.nome} ${emPorcento(r.cache_read_tokens, r.input_tokens)} ` +
        `(${r.calls} ${r.calls === 1 ? 'chamada' : 'chamadas'})`,
    )
    .join(' · ');
}

/**
 * Avalia o alerta de cache hit por JANELA (não por run) e dispara
 * inbox_items(kind='other', ref_kind='cache_hit_ratio') exatamente 1× por episódio
 * (enquanto houver item aberto, avaliações novas não duplicam — humano resolve
 * fecha o episódio).
 *
 * A razão NÃO é a média simples das razões por run: ela é ponderada por tokens de
 * entrada e só considera as chamadas CACHEÁVEIS (entrada ≥ CACHEABLE_INPUT_TOKENS_MIN).
 * Antes (#4362) o denominador somava as `llm_calls` de qualquer tamanho — os
 * classificadores, que o provedor nunca guarda em cache, afundavam a razão e o
 * aviso reabria sozinho. O texto do aviso mostra o recorte por finalidade e por
 * provedor para que a causa seja medida, não afirmada.
 */
export async function evaluateCacheHitAlert(
  db: pg.Pool,
  tenantId: string,
  knobs: CacheAlertKnobs,
): Promise<CacheAlertResult> {
  const { rows: runRows } = await db.query<{ runs: number }>(
    `select count(*)::int as runs
     from metrics
     where organization_id = $1 and name = $2
       and created_at >= now() - ($3 * interval '1 millisecond')`,
    [tenantId, CACHE_RATIO_METRIC, knobs.windowMs],
  );
  const runs = runRows[0]?.runs ?? 0;

  // Mesma janela do alerta, mesma régua do recordRunMetrics: só chamada cacheável.
  const { rows } = await db.query<RecorteDeCache>(
    `select purpose, provider,
            count(*)::int as calls,
            coalesce(sum(input_tokens), 0)::float8 as input_tokens,
            coalesce(sum(cache_read_tokens), 0)::float8 as cache_read_tokens
     from llm_calls
     where organization_id = $1
       and created_at >= now() - ($2 * interval '1 millisecond')
       and input_tokens >= ${CACHEABLE_INPUT_TOKENS_MIN}
     group by purpose, provider
     order by input_tokens desc, purpose, provider`,
    [tenantId, knobs.windowMs],
  );
  const recorte: RecorteDeCache[] = rows.map((r) => ({
    purpose: r.purpose,
    provider: r.provider,
    calls: Number(r.calls),
    input_tokens: Number(r.input_tokens),
    cache_read_tokens: Number(r.cache_read_tokens),
  }));
  const totalInput = recorte.reduce((t, r) => t + r.input_tokens, 0);
  const totalCacheRead = recorte.reduce((t, r) => t + r.cache_read_tokens, 0);
  // Nenhuma chamada cacheável na janela = nada medido; não se afirma nada.
  const avgRatio = totalInput > 0 ? totalCacheRead / totalInput : null;

  if (runs < knobs.cacheHitAlertMinRuns || avgRatio === null || avgRatio >= knobs.cacheHitAlertThreshold) {
    return { runs, avgRatio, alerted: false };
  }
  const res = await db.query(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind)
     select $1, 'other', 'warn',
            'Cache hit de prompt abaixo do alvo — custo por run acima do esperado',
            $2,
            $3
     where not exists (
       select 1 from agent_inbox_items
       where organization_id = $1 and ref_kind = $3 and status = 'open'
     )`,
    [
      tenantId,
      `Razão de cache nas chamadas cacheáveis (entrada ≥ ${CACHEABLE_INPUT_TOKENS_MIN} tokens) ` +
        `dos últimos ${runs} runs da janela = ${(avgRatio * 100).toFixed(1)}% ` +
        `(alvo ≥ ${(knobs.cacheHitAlertThreshold * 100).toFixed(0)}%). ` +
        `Recorte por finalidade: ${descreveRecorte(agregaPor(recorte, 'purpose'))}. ` +
        `Recorte por provedor: ${descreveRecorte(agregaPor(recorte, 'provider'))}. ` +
        'Chamadas com entrada abaixo desse mínimo ficam fora da conta — nenhum provedor guarda ' +
        'prefixo desse tamanho em cache, então elas não dizem nada sobre o prefixo do prompt. ' +
        'O recorte acima mostra onde a razão cai; meça a causa antes de concluir ' +
        '(prefixo do prompt ou conteúdo volátil antes do último breakpoint — ver CLAUDE.md regra 15).',
      CACHE_ALERT_REF_KIND,
    ],
  );
  return { runs, avgRatio, alerted: (res.rowCount ?? 0) > 0 };
}

export interface MetricsSnapshot {
  window_ms: number;
  /** agregado dos runs da janela (todas as orgs — endpoint local de operação) */
  runs: {
    count: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    /** média do cache_read_ratio por run — a métrica de 1ª classe (alvo ≥ threshold) */
    cache_read_ratio_avg: number | null;
    /** null = nenhum run com preço conhecido na janela */
    cost_cents: number | null;
    avg_llm_latency_ms: number | null;
  };
  /** profundidade da fila (estado corrente, não janela) */
  queue: { pending: number; running: number; dead: number };
  /** envios da janela por status do ledger — 'vetoed' = vetados (gates F2-13 somam aqui) */
  sends: { requested: number; accepted: number; queued: number; vetoed: number; failed: number };
  /** saúde por sessão WAHA (F2-14) */
  sessions: SessionHealthMetric[];
}

/**
 * Fila viva para o `/healthz`, que o docker consulta a cada 30s. Cada subselect desce
 * pelo índice parcial do seu status (`idx_job_queue_claim`, `idx_job_queue_running`);
 * agrupar por status varria a fila inteira, 90 dias de jobs terminais, para devolver
 * duas contagens. `dead` não tem índice parcial e fica no snapshot do `/metrics`.
 */
export async function profundidadeDaFilaViva(
  db: Queryable,
): Promise<{ pending: number; running: number }> {
  const { rows } = await db.query<{ pending: number; running: number }>(
    `select (select count(*)::int from job_queue where status = 'pending') as pending,
            (select count(*)::int from job_queue where status = 'running') as running`,
  );
  return { pending: rows[0]?.pending ?? 0, running: rows[0]?.running ?? 0 };
}

/** Snapshot agregado do GET /metrics — leitura pura, nada é mutado. */
export async function metricsSnapshot(db: pg.Pool, windowMs: number): Promise<MetricsSnapshot> {
  const { rows: runRows } = await db.query<{
    count: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_read_ratio_avg: number | null;
    cost_cents: number | null;
    avg_llm_latency_ms: number | null;
  }>(
    `select count(*) filter (where name = '${CACHE_RATIO_METRIC}')::int as count,
            coalesce(sum(value) filter (where name = 'run_input_tokens'), 0)::float8 as input_tokens,
            coalesce(sum(value) filter (where name = 'run_output_tokens'), 0)::float8 as output_tokens,
            coalesce(sum(value) filter (where name = 'run_cache_read_tokens'), 0)::float8 as cache_read_tokens,
            (avg(value) filter (where name = '${CACHE_RATIO_METRIC}'))::float8 as cache_read_ratio_avg,
            (sum(value) filter (where name = 'run_cost_cents'))::float8 as cost_cents,
            (avg(value) filter (where name = 'run_llm_latency_ms'))::float8 as avg_llm_latency_ms
     from metrics
     where created_at >= now() - ($1 * interval '1 millisecond')`,
    [windowMs],
  );
  const runs = runRows[0] ?? {
    count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_read_ratio_avg: null,
    cost_cents: null,
    avg_llm_latency_ms: null,
  };

  const queue = { pending: 0, running: 0, dead: 0 };
  const { rows: queueRows } = await db.query<{ status: string; n: number }>(
    'select status, count(*)::int as n from job_queue group by status',
  );
  for (const row of queueRows) {
    if (row.status in queue) queue[row.status as keyof typeof queue] = row.n;
  }

  const sends = { requested: 0, accepted: 0, queued: 0, vetoed: 0, failed: 0 };
  const { rows: sendRows } = await db.query<{ status: string; n: number }>(
    `select status, count(*)::int as n from send_ledger
     where created_at >= now() - ($1 * interval '1 millisecond')
     group by status`,
    [windowMs],
  );
  for (const row of sendRows) {
    if (row.status in sends) sends[row.status as keyof typeof sends] = row.n;
  }

  const sessions = await sessionHealthMetrics(db);

  return {
    window_ms: windowMs,
    runs: {
      count: runs.count,
      input_tokens: runs.input_tokens,
      output_tokens: runs.output_tokens,
      cache_read_tokens: runs.cache_read_tokens,
      cache_read_ratio_avg: runs.cache_read_ratio_avg,
      cost_cents: runs.cost_cents,
      avg_llm_latency_ms: runs.avg_llm_latency_ms,
    },
    queue,
    sends,
    sessions,
  };
}
