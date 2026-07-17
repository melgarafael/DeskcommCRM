/**
 * Estado durável do gate de spinning (F2-12) — Postgres do harness, sobrevive a
 * restart. Irmão de `pacing/store.ts`:
 *   - `outbound_copies` (0011): a janela deslizante das copies enviadas por número
 *     (normalizada + hash), de onde `loadRecentCopies` lê as últimas N;
 *   - `channel_knobs.spinning_knobs` (jsonb, 0011): override por número; NULL ou
 *     shape inválido cai nos SPINNING_DEFAULTS conservadores (fail-closed + warn).
 *
 * `recordCopy` é o SEAM que a cadeia de envio (F2-13) chama após o accept do CRM —
 * NÃO integrado aqui (F2-12 é só o gate; a serialização por channel_session é da F2-13).
 */
import type { Logger } from '../obs/logger';
import type { Queryable } from '../queue/queue';
import { SPINNING_DEFAULTS, type SpinningKnobs } from './defaults';
import { hashNormalized, normalizeCopy, type RecentCopy } from './engine';

/**
 * Valida o shape do jsonb de knobs (defesa em profundidade com o CHECK da 0011:
 * cobre linha legada / escritor externo). Não-objeto → null (o load usa defaults +
 * warn). Objeto → merge por campo sobre os defaults: campo ausente/errado usa o
 * default conservador silenciosamente (o CHECK só garante "é objeto"; campo a
 * campo é aqui). Regex inválido em allowlistPatterns é tratado no engine (não isenta).
 */
function parseSpinningKnobs(value: unknown): SpinningKnobs | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const patterns =
    Array.isArray(o.allowlistPatterns) && o.allowlistPatterns.every((p) => typeof p === 'string')
      ? (o.allowlistPatterns as string[])
      : SPINNING_DEFAULTS.allowlistPatterns;
  return {
    windowSize: num(o.windowSize, SPINNING_DEFAULTS.windowSize),
    similarityThreshold: num(o.similarityThreshold, SPINNING_DEFAULTS.similarityThreshold),
    repetitionThreshold: num(o.repetitionThreshold, SPINNING_DEFAULTS.repetitionThreshold),
    allowlistMaxLength: num(o.allowlistMaxLength, SPINNING_DEFAULTS.allowlistMaxLength),
    allowlistPatterns: patterns,
  };
}

/** Knobs efetivos do número: `channel_knobs.spinning_knobs` sobre os defaults. */
export async function loadSpinningKnobs(
  db: Queryable,
  tenantId: string,
  channelSessionId: string,
  logger?: Logger,
): Promise<SpinningKnobs> {
  const { rows } = await db.query<{ spinning_knobs: unknown }>(
    `select spinning_knobs from channel_knobs
     where organization_id = $1 and channel_session_id = $2`,
    [tenantId, channelSessionId],
  );
  const raw = rows[0]?.spinning_knobs;
  if (raw === null || raw === undefined) return { ...SPINNING_DEFAULTS };
  const parsed = parseSpinningKnobs(raw);
  if (!parsed) {
    // Falha FECHADO sem derrubar o worker: knob inválido → defaults conservadores.
    // ids não são PII (a disciplina do pacing/store).
    logger?.warn('spinning_knobs inválido em channel_knobs — usando defaults conservadores', {
      tenantId,
      channelSessionId,
    });
    return { ...SPINNING_DEFAULTS };
  }
  return parsed;
}

/**
 * Últimas `windowSize` copies do número (mais recentes primeiro) — a janela que o
 * engine compara. ORDER BY sent_at DESC LIMIT N é determinístico (a F2-13 serializa
 * o read-then-act por channel_session; aqui a leitura só precisa ser consistente).
 */
export async function loadRecentCopies(
  db: Queryable,
  tenantId: string,
  channelSessionId: string,
  windowSize: number,
): Promise<RecentCopy[]> {
  const { rows } = await db.query<{ normalized_text: string; normalized_hash: string }>(
    `select normalized_text, normalized_hash from outbound_copies
     where organization_id = $1 and channel_session_id = $2
     order by sent_at desc
     limit $3`,
    [tenantId, channelSessionId, windowSize],
  );
  return rows.map((r) => ({ normalizedText: r.normalized_text, normalizedHash: r.normalized_hash }));
}

/**
 * Registra uma copy efetivamente enviada — SEAM da cadeia de envio (F2-13), após o
 * accept do CRM. Normaliza e guarda o hash aqui (a mesma normalização do gate).
 * ponytail: cresce sem poda, como pacing_ledger; só as últimas N importam — job de
 * limpeza por retenção é o upgrade path se o volume pesar.
 */
export async function recordCopy(
  db: Queryable,
  tenantId: string,
  channelSessionId: string,
  body: string,
  sentAt: Date = new Date(),
): Promise<void> {
  const normalized = normalizeCopy(body);
  await db.query(
    `insert into outbound_copies (organization_id, channel_session_id, normalized_text, normalized_hash, sent_at)
     values ($1, $2, $3, $4, $5)`,
    [tenantId, channelSessionId, normalized, hashNormalized(normalized), sentAt],
  );
}
