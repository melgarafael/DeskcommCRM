/**
 * Flywheel vivo (Fase 2C/4B) — judge + distiller sobre turnos REAIS, como
 * módulo reutilizável: o script one-shot (scripts/flywheel-judge-live.ts) e o
 * loop agendado do worker chamam o MESMO runFlywheelOnce. Gate humano
 * inegociável: propostas só viram comportamento quando o dono publica na tela.
 */
import pg from 'pg';

import { runModelCall, type LlmEdgeConfig } from '../edge/llm/run-model-call';
import type { Logger } from '../obs/logger';

const JUDGE_MODEL = 'claude-haiku-4-5';
const DIMENSION = 'memory_hygiene';
const DATASET = 'live';

interface TurnRow {
  job_id: string;
  organization_id: string;
  contact_id: string;
}

interface TraceMaterial {
  transcript: string;
  notesNow: string;
  rollingSummary: string;
}

async function collectRecentTurns(pool: pg.Pool, limit: number): Promise<TurnRow[]> {
  const { rows } = await pool.query<TurnRow>(
    `select j.id as job_id, j.organization_id, j.contact_id
     from job_queue j
     where j.kind = 'inbound_turn' and j.status = 'done' and j.contact_id is not null
       and exists (select 1 from llm_calls c where c.job_id = j.id and c.purpose = 'agent_turn')
     order by j.created_at desc
     limit $1`,
    [limit],
  );
  return rows;
}

async function buildMaterial(pool: pg.Pool, turn: TurnRow): Promise<TraceMaterial> {
  const { rows: msgs } = await pool.query<{ direction: string; body: string | null }>(
    `select direction, body from messages
     where organization_id = $1 and contact_id = $2 and body is not null
     order by sent_at desc limit 12`,
    [turn.organization_id, turn.contact_id],
  );
  const transcript = msgs
    .reverse()
    .map((m) => `${m.direction === 'inbound' ? 'LEAD' : 'AGENTE'}: ${m.body}`)
    .join('\n');

  const { rows: notes } = await pool.query<{ headline: string }>(
    `select headline from lead_notes where organization_id = $1 and contact_id = $2 order by created_at`,
    [turn.organization_id, turn.contact_id],
  );
  const notesNow = notes.length > 0 ? notes.map((n) => `- ${n.headline}`).join('\n') : '(nenhuma nota durável)';

  const { rows: cp } = await pool.query<{ rolling_summary: string }>(
    `select rolling_summary from lead_checkpoints
     where organization_id = $1 and contact_id = $2 order by seq desc limit 1`,
    [turn.organization_id, turn.contact_id],
  );
  return { transcript, notesNow, rollingSummary: cp[0]?.rolling_summary ?? '(sem checkpoint)' };
}

/** yes = higiene ok; no = fato durável perdido/mal consolidado; unknown = indecidível. */
function judgePrompt(m: TraceMaterial, optionOrder: 'yes_first' | 'no_first'): string {
  const options =
    optionOrder === 'yes_first'
      ? '"yes" (higiene de memória OK) | "no" (fato durável perdido) | "unknown"'
      : '"no" (fato durável perdido) | "yes" (higiene de memória OK) | "unknown"';
  return [
    'Você é um JUIZ de qualidade de memória de um agente SDR de WhatsApp. Avalie APENAS a dimensão',
    `"${DIMENSION}": o agente preservou nas NOTAS DURÁVEIS os fatos duráveis do lead que a conversa`,
    'revelou? Fatos duráveis = identidade/negócio/necessidade/canal (ex.: nome, tipo de loja, produto).',
    'Regra: se um fato durável aparece no TRANSCRIPT ou no RESUMO mas NÃO está nas notas duráveis',
    '(porque nunca foi salvo ou porque uma consolidação o apagou), o veredito é "no".',
    '',
    '=== TRANSCRIPT (recente) ===',
    m.transcript,
    '',
    '=== RESUMO ACUMULADO (checkpoint) ===',
    m.rollingSummary,
    '',
    '=== NOTAS DURÁVEIS (estado atual) ===',
    m.notesNow,
    '',
    `Responda SOMENTE JSON: {"verdict": ${options}, "missing_facts": string[] (curtos, sem dados pessoais completos)}`,
  ].join('\n');
}

function distillerPrompt(missingFacts: string[]): string {
  return [
    'Você melhora PLAYBOOKS de agentes SDR por DELTAS mínimos. Um juiz constatou falha de higiene de',
    `memória em conversa real: fatos duráveis fora das notas do lead (${missingFacts.join('; ')}).`,
    'Causa raiz típica: o agente consolida notas com "supersedes" apagando fatos de OUTRO assunto.',
    'Proponha UM único bullet de playbook, em pt-BR, imperativo, ≤3 linhas, que previna essa classe',
    'de falha sem proibir consolidação legítima. NÃO cite dados do lead.',
    'Responda SOMENTE JSON: {"content": string}',
  ].join('\n');
}

function parseJson<T>(text: string): T {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('saída do modelo sem JSON');
  return JSON.parse(text.slice(start, end + 1)) as T;
}


export interface FlywheelRunResult {
  runId: string;
  judged: number;
  proposals: number;
}

export async function runFlywheelOnce(
  pool: pg.Pool,
  llmCfg: LlmEdgeConfig,
  opts: { limit: number; log: Logger },
): Promise<FlywheelRunResult> {
  const runId = crypto.randomUUID();
  const { limit, log } = opts;
  const turns = await collectRecentTurns(pool, limit);
  log.info('flywheel: turnos reais coletados', { run_id: runId, turns: turns.length });
  let judged = 0;
  let proposals = 0;

  for (const turn of turns) {
    const material = await buildMaterial(pool, turn);
    const optionOrder = parseInt(turn.job_id.slice(0, 8), 16) % 2 === 0 ? 'yes_first' : 'no_first';

    const judgedCall = await runModelCall(
      pool,
      llmCfg,
      {
        tenantId: turn.organization_id,
        leadId: turn.contact_id,
        jobId: turn.job_id,
        purpose: 'flywheel_judge',
        model: JUDGE_MODEL,
        messages: [{ role: 'user', content: judgePrompt(material, optionOrder) }],
      },
      { log },
    );
    const verdict = parseJson<{ verdict: string; missing_facts?: string[] }>(judgedCall.result.text);
    const verdictValue = ['yes', 'no', 'unknown'].includes(verdict.verdict) ? verdict.verdict : 'unknown';

    const { rowCount } = await pool.query(
      `insert into flywheel_judge_verdicts
         (organization_id, dataset, trace_id, dimension, verdict, option_order, judge_family, model, provenance, run_id)
       values ($1,$2,$3,$4,$5,$6,'anthropic',$7,$8,$9)
       on conflict (dataset, trace_id, dimension) do nothing`,
      [
        turn.organization_id,
        DATASET,
        turn.job_id,
        DIMENSION,
        verdictValue,
        optionOrder,
        JUDGE_MODEL,
        JSON.stringify({ source: 'live_turn', job_id: turn.job_id, contact_id: turn.contact_id }),
        runId,
      ],
    );
    const inserted = (rowCount ?? 0) > 0;
    if (inserted) judged += 1;
    log.info('flywheel: veredito gravado', { job_id: turn.job_id, verdict: verdictValue, inserted });

    if (verdictValue === 'no' && inserted) {
      const distilled = await runModelCall(
        pool,
        llmCfg,
        {
          tenantId: turn.organization_id,
          leadId: turn.contact_id,
          jobId: turn.job_id,
          purpose: 'flywheel_distiller',
          messages: [{ role: 'user', content: distillerPrompt(verdict.missing_facts ?? []) }],
        },
        { log },
      );
      const proposal = parseJson<{ content: string }>(distilled.result.text);
      await pool.query(
        `insert into flywheel_distiller_proposals
           (organization_id, run_id, dataset, type, target, content, evidence)
         values ($1,$2,$3,'playbook_bullet','tenant',$4,$5)`,
        [
          turn.organization_id,
          runId,
          DATASET,
          proposal.content,
          JSON.stringify({ trace_ids: [turn.job_id], dimension: DIMENSION, verdict_run_id: runId }),
        ],
      );
      proposals += 1;
      log.info('flywheel: proposta do distiller gravada (gate humano pendente)', { job_id: turn.job_id });
    }
  }
  return { runId, judged, proposals };
}

/** Loop agendado do flywheel (4B) — intervalo por knob; erro nunca derruba o worker. */
export async function runFlywheelLoop(
  pool: pg.Pool,
  llmCfg: LlmEdgeConfig,
  opts: { intervalMs: number; limit: number; log: Logger },
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    // dorme PRIMEIRO: no boot os turnos recentes já foram julgados pela rodada
    // anterior (dedup pela unique), e subir o worker não deve custar LLM.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, opts.intervalMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    if (signal.aborted) return;
    try {
      const result = await runFlywheelOnce(pool, llmCfg, { limit: opts.limit, log: opts.log });
      opts.log.info('flywheel: rodada agendada concluída', result as unknown as Record<string, unknown>);
    } catch (err) {
      opts.log.error('flywheel: rodada agendada falhou', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
  }
}
