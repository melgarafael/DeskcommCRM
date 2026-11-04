/** Default da janela de validade da autorização, em dias. Knob: `AI_ALLOWLIST_TTL_DAYS`. */
export const AI_ALLOWLIST_TTL_DAYS_DEFAULT = 21;


/** Lê o knob do ambiente (dias → ms). Valor ausente/inválido → default. */
export function ttlDaAutorizacaoMs(env: Record<string, string | undefined>): number {
  const raw = env.AI_ALLOWLIST_TTL_DAYS;
  const dias = raw !== undefined && raw !== "" ? Number(raw) : NaN;
  const efetivo = Number.isFinite(dias) && dias > 0 ? dias : AI_ALLOWLIST_TTL_DAYS_DEFAULT;
  return efetivo * 24 * 60 * 60 * 1000;
}
