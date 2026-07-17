/**
 * Núcleo PURO do cron (F3-01): parsing de expressão cron tz-aware, cálculo do
 * próximo disparo, stagger determinístico anti-rajada, backoff de retry e
 * classificação de erro. Sem I/O — a camada de banco/loop vive em scheduler.ts.
 *
 * Sem imports de runtime: roda direto no Node 22 (type stripping) nos testes.
 */

/** Agendamento por kind (achado OpenClaw 1.2): one-shot, recorrência fixa ou cron. */
export type CronSpec =
  | { kind: 'at'; at: Date }
  | { kind: 'every'; intervalMs: number }
  | { kind: 'cron'; expr: string; tz: string };

const MINUTE_MS = 60_000;
// Horizonte do scan minuto-a-minuto (ceiling conhecido): expressão cron válida
// sempre tem próxima ocorrência dentro de ~1 ano. Estourar = expressão impossível
// (ex.: 31 de fevereiro) → lança, e quem chama trata (schedule rejeita na criação).
const CRON_SCAN_HORIZON_MIN = 366 * 24 * 60;

const FIELD_BOUNDS = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 6],
} as const;

// en-US short weekday → 0..6 (0=domingo). Locale FIXA de propósito: a saída de
// weekday:'short' em 'en-US' é estável (Sun..Sat), ao contrário do locale default.
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

interface CronField {
  values: Set<number>;
  /** '*' original — usado na regra OR de dom/dow do cron (Vixie). */
  star: boolean;
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

/** Expande um campo cron (star, step "/n", valor, faixa "a-b", "a-b/n", "a/n", listas) em um Set. */
function parseField(raw: string, [min, max]: readonly [number, number], name: string): CronField {
  const star = raw === '*';
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const [rangeStr, stepStr] = part.split('/');
    const step = stepStr === undefined ? 1 : Number.parseInt(stepStr, 10);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`campo cron ${name} inválido: passo "${stepStr}"`);
    }
    let lo: number;
    let hi: number;
    if (rangeStr === '*' || rangeStr === '') {
      lo = min;
      hi = max;
    } else if (rangeStr!.includes('-')) {
      const [a, b] = rangeStr!.split('-').map((n) => Number.parseInt(n, 10));
      lo = a!;
      hi = b!;
    } else {
      lo = Number.parseInt(rangeStr!, 10);
      // `a/n` (sem range) = de a até o máximo, passo n (comportamento cron padrão).
      hi = stepStr === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`campo cron ${name} inválido: "${part}" (faixa ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, star };
}

/** Parseia uma expressão cron de 5 campos. `7` em day-of-week vira `0` (domingo). */
export function parseCronExpr(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`expressão cron precisa de 5 campos, veio ${fields.length}: "${expr}"`);
  }
  const dowRaw = fields[4]!.replace(/7/g, '0'); // domingo é 0 ou 7
  return {
    minute: parseField(fields[0]!, FIELD_BOUNDS.minute, 'minute'),
    hour: parseField(fields[1]!, FIELD_BOUNDS.hour, 'hour'),
    dom: parseField(fields[2]!, FIELD_BOUNDS.dom, 'day-of-month'),
    month: parseField(fields[3]!, FIELD_BOUNDS.month, 'month'),
    dow: parseField(dowRaw, FIELD_BOUNDS.dow, 'day-of-week'),
  };
}

interface WallClock {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
}

function wallClockAt(fmt: Intl.DateTimeFormat, ms: number): WallClock {
  const parts = fmt.formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    minute: Number.parseInt(get('minute'), 10),
    hour: Number.parseInt(get('hour'), 10),
    day: Number.parseInt(get('day'), 10),
    month: Number.parseInt(get('month'), 10),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? -1,
  };
}

function matches(cron: ParsedCron, wc: WallClock): boolean {
  if (!cron.minute.values.has(wc.minute)) return false;
  if (!cron.hour.values.has(wc.hour)) return false;
  if (!cron.month.values.has(wc.month)) return false;
  // Regra Vixie: dom e dow ambos restritos → OR; senão → AND (o '*' casa tudo).
  const domHit = cron.dom.values.has(wc.day);
  const dowHit = cron.dow.values.has(wc.weekday);
  if (!cron.dom.star && !cron.dow.star) return domHit || dowHit;
  return domHit && dowHit;
}

/**
 * Próximo instante (ms) estritamente após `afterMs` que casa `expr` na timezone
 * `tz` (IANA). tz-aware via Intl (DST correto: casamos a representação de parede).
 * Scan minuto-a-minuto — ver ceiling em CRON_SCAN_HORIZON_MIN.
 */
export function nextCronTime(expr: string, tz: string, afterMs: number): number {
  const cron = parseCronExpr(expr);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  // Alinha no próximo minuto cheio (garante estritamente > afterMs).
  let candidate = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let i = 0; i < CRON_SCAN_HORIZON_MIN; i += 1) {
    if (matches(cron, wallClockAt(fmt, candidate))) return candidate;
    candidate += MINUTE_MS;
  }
  throw new Error(`expressão cron sem próxima ocorrência em ${CRON_SCAN_HORIZON_MIN / 1440} dias: "${expr}" (${tz})`);
}

/**
 * Offset de stagger DETERMINÍSTICO por lead (anti-rajada): jobs no mesmo minuto
 * espalham por [0, windowMs). Mesmo lead → sempre o mesmo offset (sem thundering
 * herd, sem estado). FNV-1a 32-bit sobre o lead_id. windowMs<=0 desliga.
 */
export function staggerOffsetMs(leadId: string, windowMs: number): number {
  if (windowMs <= 0) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < leadId.length; i += 1) {
    hash ^= leadId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % windowMs;
}

/** next_run_at do PRIMEIRO disparo (base do kind + stagger). */
export function computeInitialRunAt(
  spec: CronSpec,
  nowMs: number,
  windowMs: number,
  leadId: string,
): Date {
  let base: number;
  switch (spec.kind) {
    case 'at':
      base = spec.at.getTime();
      break;
    case 'every':
      base = nowMs + spec.intervalMs;
      break;
    case 'cron':
      base = nextCronTime(spec.expr, spec.tz, nowMs);
      break;
  }
  return new Date(base + staggerOffsetMs(leadId, windowMs));
}

/**
 * next_run_at do PRÓXIMO disparo após um disparo bem-sucedido. `null` = one-shot
 * ('at') concluído — quem chama desabilita o cron.
 *   - 'every': soma o intervalo, colapsando runs perdidos (sem stampede pós-downtime).
 *     O offset de stagger é preservado (já embutido em currentRunAtMs).
 *   - 'cron': recalcula do relógio atual (auto-corretivo) + stagger.
 */
export function computeNextRunAt(
  spec: CronSpec,
  currentRunAtMs: number,
  nowMs: number,
  windowMs: number,
  leadId: string,
): Date | null {
  switch (spec.kind) {
    case 'at':
      return null;
    case 'every': {
      let next = currentRunAtMs + spec.intervalMs;
      while (next <= nowMs) next += spec.intervalMs;
      return new Date(next);
    }
    case 'cron':
      return new Date(nextCronTime(spec.expr, spec.tz, nowMs) + staggerOffsetMs(leadId, windowMs));
  }
}

/** Backoff exponencial do retry transiente (attempts 1-based). Base é knob. */
export function retryBackoffMs(attempts: number, baseMs: number): number {
  return Math.min(baseMs * 2 ** (attempts - 1), 86_400_000);
}

/**
 * Classificação EXPLÍCITA transiente vs permanente do erro de disparo, por classe
 * SQLSTATE (não heurística de mensagem):
 *   - classe 22 (data_exception) e 23 (integrity_constraint_violation) → PERMANENTE:
 *     dado/estrutura errados não se curam com retry (ex.: cron watchdog com lead →
 *     CHECK 23514 de job_queue). Desabilita + inbox.
 *   - qualquer outro (conexão caída, 42P01 tabela ausente, deadlock, erro genérico)
 *     → TRANSIENTE: pode se resolver → backoff; esgotar max_attempts vira permanente.
 */
export function classifyFireError(err: unknown): 'transient' | 'permanent' {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && (code.startsWith('22') || code.startsWith('23'))) {
    return 'permanent';
  }
  return 'transient';
}
