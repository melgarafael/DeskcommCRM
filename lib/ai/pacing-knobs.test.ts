import { describe, expect, it } from "vitest";

import { KNOB_BOUNDS, PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import {
  effectiveKnobs,
  pacingKnobsUpdateSchema,
  windowIsValid,
  knobsView,
  type ChannelKnobsRow,
} from "./pacing-knobs";

const SESSION = "aaaaaaaa-0000-4000-8000-000000000001";

describe("pacing-knobs — validação com KNOB_BOUNDS (números nunca nascem aqui)", () => {
  it("aceita update válido e rejeita acima dos bounds do engine", () => {
    expect(
      pacingKnobsUpdateSchema.safeParse({
        channel_session_id: SESSION,
        throttle_ms: KNOB_BOUNDS.intervalMaxMs,
        window_start_hour: KNOB_BOUNDS.hourLastStart,
        window_end_hour: KNOB_BOUNDS.hourEnd,
      }).success,
    ).toBe(true);
    expect(
      pacingKnobsUpdateSchema.safeParse({
        channel_session_id: SESSION,
        throttle_ms: KNOB_BOUNDS.intervalMaxMs + 1,
      }).success,
    ).toBe(false);
    expect(
      pacingKnobsUpdateSchema.safeParse({
        channel_session_id: SESSION,
        window_start_hour: KNOB_BOUNDS.hourLastStart + 1,
      }).success,
    ).toBe(false);
  });

  it("timezone IANA validada; campo desconhecido rejeitado (strict)", () => {
    expect(
      pacingKnobsUpdateSchema.safeParse({
        channel_session_id: SESSION,
        timezone: "America/Sao_Paulo",
      }).success,
    ).toBe(true);
    expect(
      pacingKnobsUpdateSchema.safeParse({
        channel_session_id: SESSION,
        timezone: "Marte/Cratera",
      }).success,
    ).toBe(false);
    expect(
      pacingKnobsUpdateSchema.safeParse({
        channel_session_id: SESSION,
        warmup_daily_caps: [],
      }).success,
    ).toBe(false);
  });

  it("teto diário: 0 rejeitado (desligar tem forma expressa), null não aceito", () => {
    expect(
      pacingKnobsUpdateSchema.safeParse({
        channel_session_id: SESSION,
        daily_message_limit: 0,
      }).success,
    ).toBe(false);
    expect(
      pacingKnobsUpdateSchema.safeParse({
        channel_session_id: SESSION,
        daily_message_limit: 300,
      }).success,
    ).toBe(true);
  });

  it("effectiveKnobs: NULL cai no default conservador; override vence", () => {
    expect(effectiveKnobs(null)).toEqual(PACING_DEFAULTS);
    const eff = effectiveKnobs({
      throttle_ms: 5000,
      jitter_max_ms: null,
      window_start_hour: 9,
      window_end_hour: null,
      allow_sunday: null,
      timezone: null,
      warmup_daily_caps: null,
    });
    expect(eff.throttleMs).toBe(5000);
    expect(eff.jitterMaxMs).toBe(PACING_DEFAULTS.jitterMaxMs);
    expect(eff.windowStartHour).toBe(9);
    expect(eff.windowEndHour).toBe(PACING_DEFAULTS.windowEndHour);
  });

  it("warmup jsonb inválido cai nos defaults (mesma leitura fail-closed do engine)", () => {
    const eff = effectiveKnobs({
      throttle_ms: null,
      jitter_max_ms: null,
      window_start_hour: null,
      window_end_hour: null,
      allow_sunday: null,
      timezone: null,
      warmup_daily_caps: [{ errado: true }],
    });
    expect(eff.warmupDailyCaps).toEqual(PACING_DEFAULTS.warmupDailyCaps);
  });

  it("janela resultante: start < end obrigatório", () => {
    expect(windowIsValid(7, 22)).toBe(true);
    expect(windowIsValid(22, 7)).toBe(false);
    expect(windowIsValid(8, 8)).toBe(false);
  });

  it("prospeccao_dias (0642): lista 1..7 de 0..6; vazio, fora da faixa e string rejeitados", () => {
    const dias = (prospeccao_dias: unknown) =>
      pacingKnobsUpdateSchema.safeParse({ channel_session_id: SESSION, prospeccao_dias });
    expect(dias([1, 2, 3, 4, 5]).success).toBe(true);
    expect(dias([0]).success).toBe(true);
    expect(dias([0, 1, 2, 3, 4, 5, 6]).success).toBe(true);
    expect(dias([]).success).toBe(false);
    expect(dias([7]).success).toBe(false);
    expect(dias([-1]).success).toBe(false);
    expect(dias([1.5]).success).toBe(false);
    expect(dias("seg-sex").success).toBe(false);
    expect(dias([0, 1, 2, 3, 4, 5, 6, 0]).success).toBe(false);
    // Omitido = mantém o gravado (não é reset parcial).
    expect(
      pacingKnobsUpdateSchema.safeParse({ channel_session_id: SESSION }).success,
    ).toBe(true);
  });

  it("effectiveKnobs: prospeccao_dias ausente cai em todos os dias; override vence", () => {
    expect(effectiveKnobs(null).prospeccaoDias).toEqual(PACING_DEFAULTS.prospeccaoDias);
    const eff = effectiveKnobs({
      throttle_ms: null,
      jitter_max_ms: null,
      window_start_hour: null,
      window_end_hour: null,
      allow_sunday: null,
      timezone: null,
      warmup_daily_caps: null,
      prospeccao_dias: [1, 3, 5],
    });
    expect(eff.prospeccaoDias).toEqual([1, 3, 5]);
    const invalido = effectiveKnobs({
      throttle_ms: null,
      jitter_max_ms: null,
      window_start_hour: null,
      window_end_hour: null,
      allow_sunday: null,
      timezone: null,
      warmup_daily_caps: null,
      prospeccao_dias: [],
    });
    expect(invalido.prospeccaoDias).toEqual(PACING_DEFAULTS.prospeccaoDias);
  });

  it("knobsView expõe defaults e bounds pra tela não cravar números", () => {
    const view = knobsView(null);
    expect(view.defaults).toEqual(PACING_DEFAULTS);
    expect(view.bounds.intervalMaxMs).toBe(KNOB_BOUNDS.intervalMaxMs);
    expect(view.bounds.daily_limit.min).toBe(1);
    expect(view.overrides).toBeNull();
  });
});

/**
 * O teto do follow-up (#4063) é um knob como os outros: a ficha e a rota
 * gravam `channel_knobs.followup_daily_cap` e o motor lê o MESMO par. O que
 * estes testes travam é o par inteiro — aceitar no schema não basta se o
 * `effectiveKnobs` não devolver o valor (a tela voltaria a mostrar 200).
 */
describe("pacing-knobs — teto do follow-up (#4063) viaja no par", () => {
  /** Linha mínima: colunas ausentes são lidas como NULL (default). */
  const LINHA: ChannelKnobsRow = {
    throttle_ms: null,
    jitter_max_ms: null,
    window_start_hour: null,
    window_end_hour: null,
    allow_sunday: null,
    timezone: null,
    warmup_daily_caps: null,
  };

  it("teto do follow-up viaja no par: 350 grava e lê 350; NULL lê 200; 0 e -1 são recusados", () => {
    // "Gravar" é o que o PATCH aceita; "ler de volta" é o que o GET devolve.
    const escrita = pacingKnobsUpdateSchema.safeParse({
      channel_session_id: SESSION,
      followup_daily_cap: 350,
    });
    expect(escrita.success).toBe(true);
    if (!escrita.success) return;
    const lido = effectiveKnobs({
      ...LINHA,
      followup_daily_cap: escrita.data.followup_daily_cap ?? null,
    });
    expect(lido.followupDailyCap).toBe(350);

    // NULL = "nunca mexi": o default de segurança continua 200, nunca 0.
    expect(effectiveKnobs({ ...LINHA, followup_daily_cap: null }).followupDailyCap).toBe(200);
    expect(PACING_DEFAULTS.followupDailyCap).toBe(200);

    // Zero e negativo não são "desligar" — desligar o número tem forma expressa.
    for (const invalido of [0, -1, 1.5]) {
      expect(
        pacingKnobsUpdateSchema.safeParse({
          channel_session_id: SESSION,
          followup_daily_cap: invalido,
        }).success,
      ).toBe(false);
    }

    // Teto máximo defensivo: o banco só exige > 0, a rota não deixa passar disto.
    expect(
      pacingKnobsUpdateSchema.safeParse({
        channel_session_id: SESSION,
        followup_daily_cap: 10_000,
      }).success,
    ).toBe(true);
    expect(
      pacingKnobsUpdateSchema.safeParse({
        channel_session_id: SESSION,
        followup_daily_cap: 10_001,
      }).success,
    ).toBe(false);
  });

  it("o dado velho não perde o campo: linha sem a coluna lê o default sem estourar", () => {
    // O PostgREST não devolve a chave para quem é anterior à migration
    // 20261121120000; `??` é o que impede o `undefined` de vazar para o motor.
    const linhaVelha = { ...LINHA } as ChannelKnobsRow;
    expect("followup_daily_cap" in linhaVelha).toBe(false);
    expect(() => effectiveKnobs(linhaVelha)).not.toThrow();
    expect(effectiveKnobs(linhaVelha).followupDailyCap).toBe(200);
    expect(knobsView(linhaVelha).effective.followupDailyCap).toBe(200);
  });
});
