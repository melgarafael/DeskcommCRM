/**
 * Épico Operação Visível (F2ii) — leitura/escrita dos knobs de pacing que o
 * engine JÁ respeita (channel_knobs, coluna NULL = default conservador) + o teto
 * diário absoluto (channel_sessions.daily_message_limit, fonte única — regra
 * dura nº 3). Validação de entrada do operador usa KNOB_BOUNDS de
 * lib/agent-engine/pacing/defaults.ts — números de pacing nunca nascem aqui.
 */
import { z } from "zod";

import {
  KNOB_BOUNDS,
  PACING_DEFAULTS,
  type PacingKnobs,
} from "@/lib/agent-engine/pacing/defaults";
import { warmupCapFor } from "@/lib/agent-engine/pacing/engine";
import { parseWarmupCaps } from "@/lib/agent-engine/pacing/store";

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanidade de UI para o teto diário (coluna do CRM, não knob do engine — o
 * engine só LÊ channel_sessions.daily_message_limit). 0 é rejeitado: "desligar
 * envios" tem forma expressa (pausar o agente), nunca um teto silencioso de 0.
 */
export const DAILY_LIMIT_BOUNDS = { min: 1, max: 10_000 } as const;

/**
 * O fuso mais adiantado que existe é UTC+14 (Kiritimati). Logo, o maior DIA de
 * calendário em vigor em algum lugar do planeta é o dia UTC de `agora + 14h`.
 */
const MAIOR_ADIANTAMENTO_MS = 14 * 3_600_000;

/** O dia do calendário (`yyyy-mm-dd`) de um instante, lido em UTC. */
function diaEmUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Hoje no calendário de quem está olhando a tela (`yyyy-mm-dd`) — o mesmo espaço
 * de valores de um `<input type="date">`, que fala em dia LOCAL.
 *
 * `new Date().toISOString().slice(0, 10)` dá o dia UTC, e a oeste ele adianta:
 * às 21h em São Paulo o `max` do campo "este número é usado desde" já oferecia
 * AMANHÃ. Limite de campo é promessa: oferecer o que o servidor recusa é o
 * controle decorativo ao contrário.
 */
export function diaDeHojeLocal(agora: Date = new Date()): string {
  const mes = String(agora.getMonth() + 1).padStart(2, "0");
  const dia = String(agora.getDate()).padStart(2, "0");
  return `${agora.getFullYear()}-${mes}-${dia}`;
}

/**
 * O DIA declarado em `number_activated_at` já começou em algum lugar do mundo?
 *
 * ## Por que a comparação é entre DIAS, e não entre um dia e um relógio
 *
 * O operador não escolhe um instante: ele escolhe um DIA num `<input
 * type="date">`, e a tela encaixa esse dia às **12h UTC** (meia-noite viraria o
 * dia anterior em qualquer fuso a oeste — ver `AntiBanSheet`). A guarda antiga
 * comparava esse encaixe com `Date.now()`, isto é, um DIA contra um RELÓGIO: o
 * encaixe de hoje só "chega" às 12:00 UTC, então declarar HOJE era recusado
 * durante toda a manhã.
 *
 * Medido no SHA f700f3e1, varrendo as 24 horas com o relógio falso, em
 * `America/Sao_Paulo` (UTC−3): a recusa começava às **03:00 UTC** (00:00 BRT — o
 * instante em que a data local vira hoje) e só parava às **12:00 UTC** (09:00
 * BRT). Nove horas de todo dia em que o campo oferecia hoje e o servidor
 * respondia "a data não pode estar no futuro". E a recusa derrubava a ficha
 * INTEIRA — o schema é `.strict()` e a rota devolve 422 antes de gravar
 * qualquer campo —, então janela, throttle e teto diário iam junto: exatamente
 * o desfecho que o PR #496 tinha acabado de consertar para o campo em branco.
 *
 * ## Por que o limite é UTC+14, e por que a folga não afrouxa proteção nenhuma
 *
 * Um dia sem fuso não tem instante: "3 de setembro" começa em UTC+14 e termina
 * em UTC−12, 26 horas depois. Como o payload não carrega o fuso do navegador, a
 * única fronteira honesta é a do planeta: recusar só o dia que não começou em
 * lugar NENHUM. Fica de fora o absurdo (2030), que é o que a guarda existe para
 * pegar.
 *
 * A folga de até um dia é segura porque data futura **não** adianta o
 * aquecimento — ela o atrasa. Quem decide isso é o MOTOR, não esta guarda:
 * `lib/agent-engine/pacing/engine.ts` faz `Math.max(0, …)` na idade, e o
 * comentário dele já dizia por quê — "number_activated_at no futuro (typo do
 * admin / clock skew) cai no degrau MAIS conservador — warm-up falha FECHADO".
 * Idade 0 é o primeiro degrau dos `PACING_DEFAULTS`: 20 envios/dia. O mesmo
 * está preso em `tests/unit/aquecimento-idade-do-numero.test.ts` ("data no
 * futuro não vira idade negativa").
 *
 * O comentário anterior desta guarda afirmava o oposto ("ela ADIANTARIA o
 * aquecimento") e era a justificativa de um rigor que só machucava quem estava
 * certo — a razão escrita contradizia o motor que ela dizia proteger.
 */
export function diaDeclaradoJaComecou(iso: string, agora: Date = new Date()): boolean {
  const instante = Date.parse(iso);
  if (!Number.isFinite(instante)) return false;
  return diaEmUtc(instante) <= diaEmUtc(agora.getTime() + MAIOR_ADIANTAMENTO_MS);
}

/** Campos editáveis pela tela — null = voltar ao default conservador do engine. */
export const pacingKnobsUpdateSchema = z
  .object({
    channel_session_id: z.string().uuid(),
    throttle_ms: z.number().int().min(0).max(KNOB_BOUNDS.intervalMaxMs).nullable().optional(),
    jitter_max_ms: z.number().int().min(0).max(KNOB_BOUNDS.intervalMaxMs).nullable().optional(),
    window_start_hour: z.number().int().min(0).max(KNOB_BOUNDS.hourLastStart).nullable().optional(),
    window_end_hour: z.number().int().min(1).max(KNOB_BOUNDS.hourEnd).nullable().optional(),
    allow_sunday: z.boolean().nullable().optional(),
    timezone: z
      .string()
      .refine(isValidTimezone, "timezone IANA inválida (ex.: America/Sao_Paulo)")
      .nullable()
      .optional(),
    daily_message_limit: z
      .number()
      .int()
      .min(DAILY_LIMIT_BOUNDS.min)
      .max(DAILY_LIMIT_BOUNDS.max)
      .optional(),
    /**
     * Desde quando o NÚMERO é usado — não desde quando esta conexão existe.
     *
     * O warm-up mede idade, e a idade nascia do instante em que o número era
     * pareado aqui: reconectar um número usado há meses o rebaixava a
     * recém-nascido (teto de 20 envios/dia) sem nenhum caminho para corrigir.
     *
     * A guarda é de SANIDADE do dia declarado, não de proteção: só recusa o dia
     * que ainda não começou em lugar nenhum do mundo. Ver
     * `diaDeclaradoJaComecou` — inclusive por que comparar com `Date.now()`
     * calava o campo durante a manhã inteira de quem está a oeste.
     */
    number_activated_at: z
      .string()
      .datetime({ offset: true })
      .refine(
        (iso) => diaDeclaradoJaComecou(iso),
        "a data é de um dia que ainda não começou em lugar nenhum do mundo",
      )
      .nullable()
      .optional(),
    /**
     * "Este número já está aquecido" — pula os degraus por completo, gravando um
     * único degrau sem teto. Existe ao lado da data porque são perguntas
     * diferentes: a data é um FATO que o dono conhece; isto é uma DECISÃO dele,
     * assumindo o risco de banimento de um número que talvez não esteja pronto.
     */
    skip_warmup: z.boolean().optional(),
  })
  .strict();

export type PacingKnobsUpdate = z.infer<typeof pacingKnobsUpdateSchema>;

export interface ChannelKnobsRow {
  throttle_ms: number | null;
  jitter_max_ms: number | null;
  window_start_hour: number | null;
  window_end_hour: number | null;
  allow_sunday: boolean | null;
  timezone: string | null;
  warmup_daily_caps: unknown;
  /** idade do número p/ warm-up (linha ausente = engine trata como idade 0). */
  number_activated_at?: string | null;
}

/**
 * Janela efetiva coerente: [start, end) com start < end — a mesma leitura que o
 * engine faz. Valida o PAR RESULTANTE (row nova mesclada com a atual/default),
 * não só os campos enviados: PATCH parcial não pode criar janela invertida.
 */
export function windowIsValid(startHour: number, endHour: number): boolean {
  return startHour < endHour;
}

/** Knobs efetivos para exibição: linha (se houver) sobre os defaults do engine. */
export function effectiveKnobs(row: ChannelKnobsRow | null): PacingKnobs {
  return {
    throttleMs: row?.throttle_ms ?? PACING_DEFAULTS.throttleMs,
    jitterMaxMs: row?.jitter_max_ms ?? PACING_DEFAULTS.jitterMaxMs,
    windowStartHour: row?.window_start_hour ?? PACING_DEFAULTS.windowStartHour,
    windowEndHour: row?.window_end_hour ?? PACING_DEFAULTS.windowEndHour,
    allowSunday: row?.allow_sunday ?? PACING_DEFAULTS.allowSunday,
    timezone: row?.timezone ?? PACING_DEFAULTS.timezone,
    warmupDailyCaps: parseWarmupCaps(row?.warmup_daily_caps) ?? PACING_DEFAULTS.warmupDailyCaps,
  };
}

/** Forma gravada em `warmup_daily_caps` quando o dono declara o número já aquecido. */
export const WARMUP_PULADO = [{ minAgeDays: 0, cap: null }] as const;

/** A configuração de warm-up desta conexão é a de "já aquecido"? */
export function warmupEstaPulado(row: ChannelKnobsRow | null): boolean {
  const caps = parseWarmupCaps(row?.warmup_daily_caps);
  return caps?.length === 1 && caps[0]?.minAgeDays === 0 && caps[0]?.cap === null;
}

/** Dias completos desde a ativação do número. Sem data = 0 (o motor é conservador). */
export function idadeEmDias(row: ChannelKnobsRow | null, agora: Date = new Date()): number {
  const iso = row?.number_activated_at;
  if (!iso) return 0;
  const ms = agora.getTime() - new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86_400_000)) : 0;
}

/**
 * Payload de GET para a tela: efetivo + o que é override + limites de edição.
 *
 * `warmup` vai junto porque a tela precisava explicar um veto que ela não sabia
 * calcular: o operador lia "número em aquecimento, limite atingido", subia o teto
 * diário — o único campo que a tela oferecia — e nada mudava, porque quem barrava
 * era o teto por IDADE. Agora o número que decide aparece ao lado do que o
 * decide.
 */
export function knobsView(row: ChannelKnobsRow | null, agora: Date = new Date()) {
  const efetivo = effectiveKnobs(row);
  const dias = idadeEmDias(row, agora);
  return {
    effective: efetivo,
    overrides: row,
    defaults: PACING_DEFAULTS,
    bounds: { ...KNOB_BOUNDS, daily_limit: DAILY_LIMIT_BOUNDS },
    warmup: {
      number_activated_at: row?.number_activated_at ?? null,
      age_days: dias,
      skipped: warmupEstaPulado(row),
      /** Teto de HOJE pelo aquecimento. null = sem teto (formado ou pulado). */
      cap_today: warmupCapFor(dias, efetivo.warmupDailyCaps),
    },
  };
}

/**
 * O valor a GRAVAR para um knob booleano da ficha Anti-ban: `null` quando o
 * operador está no default (herda), o booleano quando ele diverge (override).
 *
 * ## Por que isto existe
 *
 * Todo knob de TEXTO da ficha já sabia dizer "não mexi": campo vazio vira `null`
 * e o motor herda o default (`intOrNull`, `msOrNull`, o `trim()` do timezone).
 * O Switch de "Enviar aos domingos" não sabia — ele enviava **sempre** o
 * booleano que estava na tela, e o que estava na tela, sem override, era o
 * default do dia.
 *
 * Resultado medido em produção: em 2026-08-06 o default era `false`, e um save
 * daquela ficha — feito para declarar o aquecimento, não para mexer em domingo —
 * gravou `allow_sunday=false` como override permanente. Quando o produto mudou o
 * default para `true` em 2026-08-20, essa instalação ficou para trás com uma
 * escolha que ninguém fez, e o número passou a ficar mudo todo domingo.
 *
 * ## A regra, e o que ela preserva
 *
 * Igual ao default ⇒ `null`. Diferente ⇒ o valor.
 *
 * Isso NÃO apaga escolha de ninguém: quem desligou o domingo quando o default
 * era ligado continua com `false` gravado, porque diverge. O que some é só o
 * override que nunca foi uma decisão — e com ele some o congelamento.
 */
export function valorDeOverride(valorNaTela: boolean, padrao: boolean): boolean | null {
  return valorNaTela === padrao ? null : valorNaTela;
}
