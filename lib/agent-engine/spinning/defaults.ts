/**
 * Defaults CONSERVADORES do gate de spinning (F2-12) — a FONTE ÚNICA dos números
 * do anti-template-idêntico (blueprint 5.2: "template idêntico em massa" é gatilho
 * de ban confirmado; números anti-ban são knobs, nunca constantes). Irmão de
 * `pacing/defaults.ts`: mesmo contrato (número que não seja identidade aritmética
 * mora AQUI ou vem de `channel_knobs`, jamais espalhado no código).
 *
 * Override por número/sessão: `channel_knobs.spinning_knobs` (jsonb, 0011); coluna
 * NULL ou inválida cai nestes defaults (fail-closed conservador — ver store.ts).
 */
export interface SpinningKnobs {
  /** Janela deslizante: quantas das últimas outbound do NÚMERO (across leads) entram na comparação. */
  windowSize: number;
  /** [0,1]: similaridade Jaccard (tokens/palavras, split por espaço) >= isto conta como quase-idêntica. 1 = só idêntica exata. */
  similarityThreshold: number;
  /** Veta a candidata quando ela casa (idêntica/quase) com >= este número de copies na janela. */
  repetitionThreshold: number;
  /** Copy normalizada com comprimento <= isto é utilitária ('ok', 'combinado') e ISENTA do gate. */
  allowlistMaxLength: number;
  /** Regexes (i): copy que casa QUALQUER uma é isenta (ex.: link de pagamento, repetido é legítimo). */
  allowlistPatterns: string[];
}

export const SPINNING_DEFAULTS: SpinningKnobs = {
  // Janela e limiares conservadores: pega blast de template cedo sem sufocar
  // variação genuína. O operador afrouxa/aperta por número em channel_knobs.
  windowSize: 20,
  similarityThreshold: 0.8,
  repetitionThreshold: 2, // 2 copies iguais na janela → a 3ª é vetada (acceptance 1)
  allowlistMaxLength: 15, // 'ok', 'perfeito', 'combinado', 'muito obrigado'
  // Links de pagamento/checkout/agenda são repetidos legitimamente (o mesmo link
  // vai a vários leads) — isentos por default. Normalizado é lowercase; 'cobranc'
  // cobre 'cobrança'/'cobranca' antes do 'ç'. É ponto de partida: o operador ajusta.
  allowlistPatterns: ['https?://\\S*(pay|pag|checkout|pix|boleto|cobranc)'],
};
