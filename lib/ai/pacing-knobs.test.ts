import { describe, expect, it } from "vitest";

import { KNOB_BOUNDS, PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import {
  effectiveKnobs,
  pacingKnobsUpdateSchema,
  windowIsValid,
  knobsView,
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

  it("knobsView expõe defaults e bounds pra tela não cravar números", () => {
    const view = knobsView(null);
    expect(view.defaults).toEqual(PACING_DEFAULTS);
    expect(view.bounds.intervalMaxMs).toBe(KNOB_BOUNDS.intervalMaxMs);
    expect(view.bounds.daily_limit.min).toBe(1);
    expect(view.overrides).toBeNull();
  });
});
