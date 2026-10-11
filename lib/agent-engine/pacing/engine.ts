/**
 * Motor de pacing anti-ban (F2-11) — decisão PURA: dado (relógio, knobs, estado
 * de envios do número, limite diário do CRM, rng) devolve {allow, waitMs} ou
 * {veto, nextAllowedAt, reason pt-br instrutivo}. Roda ANTES de chamar o CRM
 * (regra dura nº 3); a integração na cadeia de envio é da F2-13 — aqui não há
 * I/O nenhum. Clock e RNG são injetáveis (testes com clock fake e jitter
 * determinístico); em produção o chamador passa `new Date()` e omite o rng.
 *
 * Ordem de avaliação: janela horária (tz do tenant, domingo conforme `allowSunday`,
 * dias próprios na prospecção) → caps diários (warm-up por idade do número;
 * limite do CRM injetado) → throttle+jitter.
 */
import type { PacingKnobs, WarmupStep } from './defaults';

export interface PacingState {
  /** Último envio deste número (qualquer dia) — base do throttle. */
  lastSentAt: Date | null;
  /** Envios deste número desde a meia-noite LOCAL do tenant. */
  sentToday: number;
  /** Ativação do número (channel_knobs.number_activated_at); null = idade 0 (conservador). */
  numberActivatedAt: Date | null;
}

export interface PacingInput {
  now: Date;
  knobs: PacingKnobs;
  state: PacingState;
  /**
   * channel_sessions.daily_message_limit (fonte única do cap diário absoluto) —
   * mesmo banco agora: o chamador lê por query direta, não por edge HTTP.
   * null = sem limite conhecido. O Deskcomm também tem channel_sessions
   * warmup_started_at/warmup_completed_at/is_warmup_complete, mas o warm-up DESTE
   * motor é o cálculo próprio por idade (channel_knobs.number_activated_at +
   * degraus) — não os campos do CRM.
   */
  crmDailyLimit: number | null;
  /**
   * O canal tem risco de BANIMENTO por volume/padrão? (capability do provider).
   * `false` desarma SÓ o que é anti-ban (warm-up, cap diário, throttle+jitter);
   * janela horária/domingo/fuso são CORTESIA e continuam valendo em todo canal
   * (doutrina `docs/doctrine/restricao-de-canal.md`, invariante 3).
   * Omitir = `true`: nenhum chamador existente muda de comportamento.
   */
  banRisk?: boolean;
  /**
   * Esta decisão é para a RESPOSTA do agente (o cliente escreveu e espera
   * resposta) ou para o DISPARO (envio em massa / retomada de conversa parada)?
   *
   * ⚠️ `true` (resposta) lê `resposta*`; `false`/omitido (disparo) lê
   * `window*`. Default `false` porque TODO chamador existente é disparo ou
   * não-POSTO — o `pacingGate` precisa declarar a resposta explicitamente para
   * a separação valer, e é o que a torna visível numa revisão de código.
   *
   * Responder e disparar são riscos diferentes: 50 mensagens de madrugada
   * levam o número ao banimento; uma resposta para quem escreveu às 3h é o serviço.
   */
  resposta?: boolean;
  /**
   * Esta decisão é para a PROSPECÇÃO fria (primeira abordagem a quem nunca
   * falou com a empresa)?
   *
   * `true` lê os dias próprios da prospecção (`knobs.prospeccaoDias`, 0642) em
   * vez do `allowSunday` compartilhado — é o que desamarra "respondo domingo"
   * de "prospecto domingo". As HORAS continuam as de disparo (`window*`):
   * `resposta` é ignorado quando este campo é `true` (prospecção nunca é
   * resposta). Omitir = comportamento anterior — todo chamador fora do worker
   * de prospecção continua como está.
   */
  prospeccao?: boolean;
  /** [0,1) — injetável nos testes; default Math.random. */
  rng?: () => number;
}

export type PacingVetoCode = 'outside_window' | 'warmup_cap' | 'daily_cap';

export type PacingDecision =
  | { allow: true; waitMs: number }
  | { allow: false; code: PacingVetoCode; nextAllowedAt: Date; reason: string };

const DAY_MS = 86_400_000;

export function decidePacing(input: PacingInput): PacingDecision {
  const { now, knobs, state, crmDailyLimit } = input;
  const rng = input.rng ?? Math.random;
  const banRisk = input.banRisk ?? true; // default preserva o comportamento atual
  const resposta = input.resposta ?? false; // default = disparo (janela restritiva)
  const prospeccao = input.prospeccao ?? false; // default = sem dias próprios
  const wall = wallClock(now, knobs.timezone);
  // Resposta lê `resposta*`, disparo lê `window*`. Coluna vazia já chega aqui
  // preenchida com a de disparo (`loadChannelKnobs`, 0495). Prospecção é
  // disparo nas horas e própria nos dias — `resposta` não se aplica a ela.
  const janela = janelaDoPacing(knobs, prospeccao ? false : resposta);
  const diasProspeccao = prospeccao ? knobs.prospeccaoDias : null;

  if (!insideWindow(wall, knobs, janela, diasProspeccao)) {
    const nextAllowedAt = addMs(
      nextWindowOpen(now, knobs, janela, diasProspeccao),
      jitterOf(rng, knobs),
    );
    const nome = prospeccao ? 'prospecção' : resposta ? 'resposta' : 'envio';
    const dias = prospeccao
      ? `, dias ${diasParaTexto(knobs.prospeccaoDias)}`
      : knobs.allowSunday
        ? ''
        : ', sem domingo';
    return {
      allow: false,
      code: 'outside_window',
      nextAllowedAt,
      reason:
        `fora da janela de ${nome} (${janela.start}h-${janela.end}h` +
        `${dias}, ${knobs.timezone}); ` +
        `agende para ${formatInTz(nextAllowedAt, knobs.timezone)} (abertura da janela + jitter)`,
    };
  }

  // Daqui para baixo tudo é ANTI-BAN (warm-up, cap diário, throttle+jitter): só
  // arma onde há risco de banimento. A janela horária acima é CORTESIA e roda
  // SEMPRE — desarmar as duas juntas acordaria cliente às 3h (invariante 3).
  if (!banRisk) return { allow: true, waitMs: 0 };

  // Clamp em >= 0: number_activated_at no futuro (typo do admin / clock skew
  // daemon↔DB) cai no degrau MAIS conservador — warm-up falha FECHADO, nunca
  // vira "número formado" por idade negativa.
  const ageDays = state.numberActivatedAt
    ? Math.max(0, Math.floor((now.getTime() - state.numberActivatedAt.getTime()) / DAY_MS))
    : 0;
  const wCap = warmupCapFor(ageDays, knobs.warmupDailyCaps);
  const effectiveCap = Math.min(wCap ?? Infinity, crmDailyLimit ?? Infinity);
  if (state.sentToday >= effectiveCap) {
    const nextAllowedAt = addMs(nextDayOpen(now, knobs, diasProspeccao), jitterOf(rng, knobs));
    const isWarmup = wCap !== null && wCap < (crmDailyLimit ?? Infinity);
    return {
      allow: false,
      code: isWarmup ? 'warmup_cap' : 'daily_cap',
      nextAllowedAt,
      reason: isWarmup
        ? `cap de warm-up atingido (${wCap}/dia para número com ${ageDays} dia(s) de idade); ` +
          `agende para ${formatInTz(nextAllowedAt, knobs.timezone)} (próxima abertura + jitter)`
        : `cap diário do número atingido (${effectiveCap}/dia, limite do CRM); ` +
          `agende para ${formatInTz(nextAllowedAt, knobs.timezone)} (próxima abertura + jitter)`,
    };
  }

  let waitMs = 0;
  if (state.lastSentAt) {
    const requiredGapMs = knobs.throttleMs + jitterOf(rng, knobs);
    waitMs = Math.max(0, requiredGapMs - (now.getTime() - state.lastSentAt.getTime()));
  }
  return { allow: true, waitMs };
}

/**
 * Degrau vigente para a idade (degraus ordenados por minAgeDays crescente).
 * Falha FECHADO: idade aquém do primeiro degrau usa o cap do PRIMEIRO degrau
 * (o mais conservador) — configuração com furo nunca vira "sem cap".
 *
 * Exportada para a TELA poder dizer ao operador qual é o teto de hoje. A regra
 * tem de ser esta mesma função: uma segunda cópia na UI é a receita para a tela
 * prometer um número e o motor aplicar outro.
 */
export function warmupCapFor(ageDays: number, steps: WarmupStep[]): number | null {
  let cap: number | null = steps[0]?.cap ?? null;
  for (const step of steps) {
    if (ageDays >= step.minAgeDays) cap = step.cap;
  }
  return cap;
}

function jitterOf(rng: () => number, knobs: PacingKnobs): number {
  return Math.floor(rng() * (knobs.jitterMaxMs + 1));
}

function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}

// ---------------------------------------------------------------------------
// Relógio de parede na tz do tenant — Intl puro, sem dependência nova.

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  weekday: string; // 'Sun'..'Sat'
}

function wallClock(instant: Date, timezone: string): Wall {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  }).formatToParts(instant);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    y: Number(get('year')),
    mo: Number(get('month')),
    d: Number(get('day')),
    h: Number(get('hour')) % 24, // algumas ICU rendem '24' à meia-noite
    mi: Number(get('minute')),
    s: Number(get('second')),
    weekday: get('weekday'),
  };
}

/**
 * Instante UTC cuja hora de parede na tz é (y, mo, d, h):00 — técnica clássica
 * de duas passadas pelo offset (correta inclusive sob DST).
 */
function instantFromWall(y: number, mo: number, d: number, h: number, timezone: string): Date {
  const targetAsUtc = Date.UTC(y, mo - 1, d, h);
  let guess = targetAsUtc;
  for (let i = 0; i < 2; i += 1) {
    const w = wallClock(new Date(guess), timezone);
    const guessAsUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
    guess += targetAsUtc - guessAsUtc;
  }
  return new Date(guess);
}

/** Meia-noite LOCAL do tenant contendo `instant` — o corte do "hoje" dos caps diários. */
export function dayStartInTz(instant: Date, timezone: string): Date {
  const w = wallClock(instant, timezone);
  return instantFromWall(w.y, w.mo, w.d, 0, timezone);
}

/**
 * A janela horária está aberta agora? Exportada para quem precisa da pergunta
 * ANTES de ter uma mensagem para enviar — hoje o turno inbound, que adia o job
 * inteiro em vez de gastar uma chamada de modelo cujo texto o gate vetaria na
 * saída (ver `inbound-turn.ts`). O gate de envio continua sendo o que decide de
 * verdade: isto é só o atalho barato, sem tocar em caps nem em throttle.
 *
 * `resposta` separa as janelas: o turno inbound é RESPOSTA (lê `resposta*`) e
 * o disparo/retomada é `false` (lê `window*`). Omitir = disparo, que é o
 * comportamento de todo chamador anterior a 0495. A prospecção NÃO passa por
 * aqui: ela tem os dias próprios (`janelaDeProspeccaoAberta`, 0642).
 */
export function janelaDeEnvioAberta(
  now: Date,
  knobs: PacingKnobs,
  resposta = false,
): boolean {
  return insideWindow(wallClock(now, knobs.timezone), knobs, janelaDoPacing(knobs, resposta));
}

/** Próxima abertura da janela + jitter — o instante para o qual se adia. */
export function proximaAberturaDaJanela(
  now: Date,
  knobs: PacingKnobs,
  resposta = false,
  rng: () => number = Math.random,
): Date {
  return addMs(
    nextWindowOpen(now, knobs, janelaDoPacing(knobs, resposta)),
    jitterOf(rng, knobs),
  );
}

/** Qual janela de [start, end) vale para esta decisão: a da RESPOSTA ou a do DISPARO. */
function janelaDoPacing(
  knobs: PacingKnobs,
  resposta: boolean,
): { start: number; end: number } {
  if (!resposta) return { start: knobs.windowStartHour, end: knobs.windowEndHour };
  return { start: knobs.respostaStartHour, end: knobs.respostaEndHour };
}

/** Dia da semana na convenção JS (`getDay`): 0=domingo … 6=sábado. */
const DIA_POR_NOME: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const NOME_CURTO_DO_DIA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'] as const;

/** Lista de dias para a `reason` do veto — display apenas, nunca regra. */
function diasParaTexto(dias: number[]): string {
  return dias.map((d) => NOME_CURTO_DO_DIA[d] ?? String(d)).join(',');
}

/**
 * Normaliza o filtro de dias da prospecção. Vazio ou ausente = regra antiga
 * (`allowSunday`): um array vazio significaria "nenhum dia envia", que é fila
 * parada em silêncio — e `nextWindowOpen` sem dia válido seria um laço sem fim.
 * O `loadChannelKnobs` já garante não-vazio do banco; isto cobre knobs
 * montados à mão (testes, chamadores futuros).
 */
function diasValidos(dias?: number[] | null): number[] | null {
  return dias && dias.length > 0 ? dias : null;
}

function insideWindow(
  wall: Wall,
  knobs: PacingKnobs,
  janela: { start: number; end: number },
  diasProspeccao?: number[] | null,
): boolean {
  const dias = diasValidos(diasProspeccao);
  if (dias) {
    // Dias próprios (0642): o domingo compartilhado não entra — é o que permite
    // responder domingo sem prospectar domingo.
    if (!dias.includes(DIA_POR_NOME[wall.weekday] ?? -1)) return false;
    return wall.h >= janela.start && wall.h < janela.end;
  }
  if (!knobs.allowSunday && wall.weekday === 'Sun') return false;
  return wall.h >= janela.start && wall.h < janela.end;
}

/** Próxima abertura de janela ESTRITAMENTE depois de `now` (pula domingo se evitado). */
function nextWindowOpen(
  now: Date,
  knobs: PacingKnobs,
  janela: { start: number; end: number } = { start: knobs.windowStartHour, end: knobs.windowEndHour },
  diasProspeccao?: number[] | null,
): Date {
  const dias = diasValidos(diasProspeccao);
  const w = wallClock(now, knobs.timezone);
  for (let add = 0; ; add += 1) {
    // Date.UTC normaliza overflow de dia/mês em instantFromWall.
    const candidate = instantFromWall(w.y, w.mo, w.d + add, janela.start, knobs.timezone);
    if (candidate.getTime() <= now.getTime()) continue;
    const weekday = wallClock(candidate, knobs.timezone).weekday;
    if (dias) {
      if (!dias.includes(DIA_POR_NOME[weekday] ?? -1)) continue;
    } else if (!knobs.allowSunday && weekday === 'Sun') continue;
    return candidate;
  }
}

/**
 * Abertura do PRÓXIMO dia permitido (cap diário reseta na meia-noite local).
 *
 * Usa a janela de DISPARO, não a de resposta, de propósito: cap diário é
 * proteção anti-ban e vale para qualquer envio. Se o cap for atingido às 3h por
 * causa de uma resposta a quem escreveu, o "amanhã" que se anuncia é o
 * reaparecimento do número às 7h, e isso é a única coisa que faz sentido
 * dizer a quem pagou.
 */
function nextDayOpen(now: Date, knobs: PacingKnobs, diasProspeccao?: number[] | null): Date {
  const dias = diasValidos(diasProspeccao);
  const w = wallClock(now, knobs.timezone);
  for (let add = 1; ; add += 1) {
    const candidate = instantFromWall(w.y, w.mo, w.d + add, knobs.windowStartHour, knobs.timezone);
    const weekday = wallClock(candidate, knobs.timezone).weekday;
    if (dias) {
      if (!dias.includes(DIA_POR_NOME[weekday] ?? -1)) continue;
    } else if (!knobs.allowSunday && weekday === 'Sun') continue;
    return candidate;
  }
}

/**
 * A PROSPECÇÃO pode abordar agora? Dias próprios (`prospeccaoDias`) + horas de
 * disparo (`window*`) — o domingo compartilhado (`allowSunday`) não entra.
 * Atalho barato para o worker, como `janelaDeEnvioAberta` é para o turno
 * inbound: o gate de verdade continua sendo o `decidePacing` com
 * `prospeccao: true` logo abaixo.
 */
export function janelaDeProspeccaoAberta(now: Date, knobs: PacingKnobs): boolean {
  return insideWindow(
    wallClock(now, knobs.timezone),
    knobs,
    { start: knobs.windowStartHour, end: knobs.windowEndHour },
    knobs.prospeccaoDias,
  );
}

/** Próxima abertura da prospecção + jitter — o instante para o qual se adia. */
export function proximaAberturaDaProspeccao(
  now: Date,
  knobs: PacingKnobs,
  rng: () => number = Math.random,
): Date {
  return addMs(
    nextWindowOpen(
      now,
      knobs,
      { start: knobs.windowStartHour, end: knobs.windowEndHour },
      knobs.prospeccaoDias,
    ),
    jitterOf(rng, knobs),
  );
}

/** Render local legível para a mensagem de veto (pt-br vê hora do SEU fuso). */
function formatInTz(instant: Date, timezone: string): string {
  // sv-SE rende 'YYYY-MM-DD HH:mm:ss' — ISO-like, sem dependência.
  return `${new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(instant)} (${timezone})`;
}
