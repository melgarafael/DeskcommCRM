/**
 * Defaults CONSERVADORES do circuito de saúde do número (F2-26) — a FONTE ÚNICA dos
 * números do circuito (blueprint risco nº 1: block/response rate como circuito de
 * proteção contra ban; achado 5.2: knobs, nunca constantes). Irmão de
 * `pacing/defaults.ts` e `spinning/defaults.ts`: número que não seja identidade
 * aritmética mora AQUI ou vem de `channel_knobs.health_knobs`, jamais espalhado —
 * `scripts/lint-health.ts` reprova constante de saúde fora deste módulo (acc 3).
 *
 * Filosofia do default: SEGURAR é não-destrutivo (a fila retém, nunca dropa — o
 * humano resolve). Então erramos para segurar cedo no block rate. Já o response
 * rate é um PROXY (inbound/outbound na janela — ver health/circuit.ts) que precisa
 * de tuning com dado real antes de auto-segurar: por isso o piso nasce em 0
 * (desligado), opt-in por número. Block rate é o circuito ativo por default.
 */
export interface HealthKnobs {
  /** Janela móvel (ms) sobre a qual block/response rate são computados. */
  windowMs: number;
  /** block rate (fração de outbound vetado por is_blocked) >= isto → hold. */
  blockRateThreshold: number;
  /** Mínimo de tentativas de outbound na janela antes do block rate poder disparar. */
  blockRateMinSends: number;
  /** response rate (leads que responderam / leads a quem enviamos) < isto → hold. 0 = desligado. */
  responseRateFloor: number;
  /** Mínimo de leads contatados na janela antes do response rate poder disparar. */
  responseRateMinSends: number;
  /** Tempo mínimo em hold antes da retomada AUTOMÁTICA (com métricas recuperadas). */
  cooldownMs: number;
}

export const HEALTH_DEFAULTS: HealthKnobs = {
  // 6h: pega uma degradação de entregabilidade no mesmo dia sem reagir a ruído de
  // minutos. O operador aperta/afrouxa por número em channel_knobs.health_knobs.
  windowMs: 21_600_000,
  // 10% de outbound vetado por bloqueio já é forte sinal de queima do número; com
  // >= 10 tentativas na janela para não alarmar em amostra rasa (2 vetos em 3 = 66%).
  blockRateThreshold: 0.1,
  blockRateMinSends: 10,
  // Proxy off por default (opt-in por número): só segura por response rate quando o
  // operador sobe o piso; até lá o response rate é só observado, nunca auto-segura.
  responseRateFloor: 0,
  responseRateMinSends: 20,
  // 1h em hold antes de a retomada automática ficar elegível (e só se recuperado);
  // a retomada manual (resolver o inbox_item) não espera o cool-down.
  cooldownMs: 3_600_000,
};
