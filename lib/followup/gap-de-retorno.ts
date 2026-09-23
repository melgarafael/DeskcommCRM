/**
 * O BURACO QUE FAZ UM INBOUND SER RETORNO, não conversa em curso.
 *
 * Silêncio é AUSÊNCIA de inbound por X. Retorno é a CHEGADA de um inbound
 * depois desse X. Os dois leem o mesmo fato (quando o cliente falou pela
 * última vez), mas o instante de agir é o oposto — e por isso a conta vive
 * num módulo que nenhum dos dois motores pode distorcer.
 *
 * A unidade na tela é escolha do operador (minutos / horas / dias). O fio
 * guarda SÓ minutos, igual ao gatilho de silêncio: duas verdades (valor +
 * unidade) divergem na primeira edição. A tela reconstrói a unidade na leitura.
 */

export const UNIDADES_DE_LIMIAR = ["minutes", "hours", "days"] as const;
export type UnidadeDeLimiar = (typeof UNIDADES_DE_LIMIAR)[number];

/** Piso: 1 hora. Abaixo disso é rajada, não cliente que voltou. */
export const MIN_THRESHOLD_MINUTES = 60;
/** Teto: 90 dias. Decisão de produto para negócio com cliente recorrente. */
export const MAX_THRESHOLD_MINUTES = 90 * 24 * 60;
/** Padrão da tela: 1 dia. */
export const DEFAULT_THRESHOLD_MINUTES = 24 * 60;

const MINUTOS_POR: Record<UnidadeDeLimiar, number> = {
  minutes: 1,
  hours: 60,
  days: 24 * 60,
};

export function minutosDoLimiar(valor: number, unidade: UnidadeDeLimiar): number {
  if (!Number.isFinite(valor) || valor <= 0) return Number.NaN;
  return Math.round(valor * MINUTOS_POR[unidade]);
}

/**
 * Reconstrói valor + unidade a partir dos minutos gravados.
 * Prefere a maior unidade que divide inteiro — 1440 vira "1 dia", não "1440 minutos".
 */
export function limiarDaTela(minutes: number): { valor: number; unidade: UnidadeDeLimiar } {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { valor: 1, unidade: "days" };
  }
  if (minutes % MINUTOS_POR.days === 0) {
    return { valor: minutes / MINUTOS_POR.days, unidade: "days" };
  }
  if (minutes % MINUTOS_POR.hours === 0) {
    return { valor: minutes / MINUTOS_POR.hours, unidade: "hours" };
  }
  return { valor: minutes, unidade: "minutes" };
}

export function limiarValido(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= MIN_THRESHOLD_MINUTES && minutes <= MAX_THRESHOLD_MINUTES;
}

/**
 * `anterior === null` é o primeiro inbound da vida: não é retorno.
 * O limiar é inclusivo: exatamente X minutos depois, dispara.
 */
export function gapQualificaRetorno(
  anterior: Date | null,
  agora: Date,
  thresholdMinutes: number,
): boolean {
  if (anterior === null) return false;
  if (!limiarValido(thresholdMinutes)) return false;
  const gapMs = agora.getTime() - anterior.getTime();
  if (!Number.isFinite(gapMs) || gapMs < 0) return false;
  return gapMs >= thresholdMinutes * 60_000;
}

/** Segmentos vazios = todo mundo. Um tag em comum basta. */
export function segmentoCasa(segments: string[], tags: string[]): boolean {
  if (segments.length === 0) return true;
  const set = new Set(tags);
  return segments.some((s) => set.has(s));
}
