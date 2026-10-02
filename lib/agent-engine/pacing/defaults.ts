/**
 * Defaults CONSERVADORES do motor anti-ban (F2-11) — a FONTE ÚNICA dos números
 * de pacing do daemon (blueprint 5.2: números anti-ban são fonte única e
 * inconsistente → knobs, nunca constantes). `scripts/lint-pacing.ts` reprova
 * literal de pacing em qualquer outro arquivo de daemon/src.
 *
 * Override por número/sessão: linha em `channel_knobs` (0010) — coluna NULL cai
 * aqui. O CAP DIÁRIO ABSOLUTO não mora aqui nem em channel_knobs: a fonte única
 * é `channel_sessions.daily_message_limit` (regra dura nº 3) — mesmo banco agora,
 * a cadeia de envio lê por query direta e injeta em `decidePacing` (`crmDailyLimit`).
 */

/** Degrau de warm-up: a partir de `minAgeDays` de idade do número vale `cap` envios/dia; `cap: null` = formado (sem cap de warm-up — resta só o limite do CRM). */
export interface WarmupStep {
  minAgeDays: number;
  cap: number | null;
}

export interface PacingKnobs {
  /** Intervalo mínimo entre envios do MESMO número (ms). */
  throttleMs: number;
  /** Teto do jitter randômico somado ao throttle e ao next_allowed_at (ms) — intervalo fixo é assinatura de bot. */
  jitterMaxMs: number;
  /**
   * Parcela FIXA do atraso humano antes da 1ª bolha (ms): ver a notificação,
   * abrir a conversa, ler o que o cliente escreveu. Existe separada do termo
   * proporcional porque mesmo um "Sim!" tem esse custo (atraso-humano.ts).
   * NULL em channel_knobs = este default.
   */
  atrasoNotarMs: number;
  /** Taxa de digitação do atraso humano (ms por caractere) — default 22ms ≈ 45 c/s. NULL = default. */
  msPorCaractere: number;
  /** Piso do atraso humano (ms) — abaixo dele o atraso não significa nada. NULL = default. */
  atrasoMinimoMs: number;
  /** Teto do atraso humano (ms) — acima dele o silêncio lê como queda. NULL = default. */
  atrasoMaximoMs: number;
  /**
   * Janela horária de DISPARO [start, end) na hora local do tenant — vale para o
   * disparo em massa (`lib/prospecting/worker.ts`) e para a retomada de conversa
   * parada (`lib/automation/janela-do-canal.ts`).
   */
  windowStartHour: number;
  windowEndHour: number;
  /**
   * Janela horária da RESPOSTA do agente [start, end), na mesma hora local.
   *
   * ═══ Por que ela é separada ═══
   *
   * Responder e disparar são riscos diferentes. Disparar 50 mensagens de madrugada
   * banina o número; responder UMA pessoa que escreveu às 3h é o serviço, e é o
   * que o dono comprou. Com um knob só, abrir o atendimento para 24h abria
   * junto o disparo — e o dono pediu exatamente para que NÃO abrisse.
   *
   * Por isso o `PacingInput` do gate tem `resposta_*` em vez de mexer na janela
   * global: `insideWindow` do disparo continua lendo `window*`, e a RESPOSTA lê
   * estes dois. Um canal que nunca gravou as colunas novas (`null` no banco)
   * recebe `PACING_DEFAULTS.resposta*` — que espelham `window*` —, então nenhum
   * clone muda de comportamento por omissão.
   *
   * ⚠️ `allowSunday` NÃO tem par aqui de propósito: domingo liberado é o default
   * desde a 0010 e vale para as duas janelas. Se um dia domingo virar knob
   * separado, ele pertence aqui, não em `PacingInput`.
   */
  respostaStartHour: number;
  respostaEndHour: number;
  /**
   * Enviar aos domingos. **Ligado por default** — a janela horária cala à noite,
   * e o domingo inteiro mudo era cortesia demais: num CRM de atendimento, quem
   * escreve no domingo espera resposta no domingo.
   *
   * Continua sendo knob por canal (`AntiBanSheet` → `POST /api/v1/ai/pacing`):
   * quem faz prospecção ativa e prefere não incomodar no fim de semana desliga.
   */
  allowSunday: boolean;
  /** IANA timezone do tenant — a janela é avaliada NELA. */
  timezone: string;
  /** Degraus de warm-up ordenados por minAgeDays crescente (o primeiro cobre idade 0). */
  warmupDailyCaps: WarmupStep[];
}

/**
 * Limites de SANIDADE da edição de knobs no Console (FU-14) — validação de entrada do
 * operador, não defaults de comportamento. Moram aqui porque a doutrina proíbe número de
 * pacing fora deste módulo (scripts/lint-pacing.ts); o Console os importa em vez de
 * cravar literais.
 */
export const KNOB_BOUNDS = {
  /** teto de intervalo/jitter aceito na UI (ms). */
  intervalMaxMs: 600_000,
  /** teto de ms_por_caractere aceito na UI (ms) — 202ms ≈ 5 c/s é absurdamente lento; nada real precisa de mais. */
  msPorCaractereMax: 200,
  /** teto do atraso máximo aceito na UI (ms) — o piso é o default do anti-ban (1200). */
  atrasoMaximoMsMax: 60_000,
  /** maior hora aceita como INÍCIO de janela (fim vai até 24). */
  hourLastStart: 23,
  /** fim de janela é exclusivo e pode chegar à meia-noite seguinte. */
  hourEnd: 24,
} as const;

export const PACING_DEFAULTS: PacingKnobs = {
  throttleMs: 1200, // 1 msg / 1,2s
  jitterMaxMs: 800,
  // Números do atraso humano antes da 1ª bolha (atraso-humano.ts). Espelham os
  // valores que foram SEMPRE os literais do módulo — regressão zero para quem
  // nunca configurou. Coluna em channel_knobs NULL cai aqui.
  atrasoNotarMs: 900,
  msPorCaractere: 22,
  atrasoMinimoMs: 1200,
  atrasoMaximoMs: 7500,
  windowStartHour: 7, // janela 7h-22h
  windowEndHour: 22,
  // Espelha a janela de disparo: quem nunca gravou as colunas `resposta_*`
  // continua com o comportamento de sempre (a resposta espera fora da janela).
  // O dono que QUER 24h grava 0 e 24 no `channel_knobs` — não neste arquivo,
  // que é default de fallback, não configuração de instalação.
  respostaStartHour: 7,
  respostaEndHour: 22,
  allowSunday: true,
  timezone: 'America/Sao_Paulo',
  // Número sem linha em channel_knobs é tratado como idade 0 (o degrau mais
  // conservador) até alguém registrar number_activated_at.
  warmupDailyCaps: [
    { minAgeDays: 0, cap: 20 },
    { minAgeDays: 4, cap: 50 },
    { minAgeDays: 8, cap: 100 },
    { minAgeDays: 15, cap: 200 },
    { minAgeDays: 31, cap: null },
  ],
};
