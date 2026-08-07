/**
 * O aquecimento mede a idade do NÚMERO, e essa idade nascia do instante em que o
 * número era pareado. Reconectar um número usado há meses o rebaixava a
 * recém-nascido — teto de 20 envios/dia — e não havia caminho nenhum para
 * corrigir: o contrato da API era `.strict()` e não aceitava nem a data de
 * ativação nem os degraus.
 *
 * Pior: a tela oferecia o teto DIÁRIO, que é outro gate. O operador subia o teto
 * para 1000, nada mudava, e a mensagem seguia falando de aquecimento.
 */
import { describe, expect, it } from "vitest";

import {
  WARMUP_PULADO,
  idadeEmDias,
  knobsView,
  pacingKnobsUpdateSchema,
  warmupEstaPulado,
  type ChannelKnobsRow,
} from "@/lib/ai/pacing-knobs";

const SESSAO = "11111111-1111-4111-8111-111111111111";
const VAZIO: ChannelKnobsRow = {
  throttle_ms: null,
  jitter_max_ms: null,
  window_start_hour: null,
  window_end_hour: null,
  allow_sunday: null,
  timezone: null,
  warmup_daily_caps: null,
  number_activated_at: null,
};

describe("contrato da API — os campos que faltavam", () => {
  it("aceita a data de ativação do número", () => {
    const r = pacingKnobsUpdateSchema.safeParse({
      channel_session_id: SESSAO,
      number_activated_at: "2026-04-29T02:15:52.000Z",
    });
    expect(r.success).toBe(true);
  });

  it("recusa data no FUTURO — adiantar o aquecimento é o oposto de proteger", () => {
    const amanha = new Date(Date.now() + 86_400_000).toISOString();
    const r = pacingKnobsUpdateSchema.safeParse({
      channel_session_id: SESSAO,
      number_activated_at: amanha,
    });
    expect(r.success).toBe(false);
  });

  it("aceita null — volta a tratar o número como recém-criado", () => {
    const r = pacingKnobsUpdateSchema.safeParse({
      channel_session_id: SESSAO,
      number_activated_at: null,
    });
    expect(r.success).toBe(true);
  });

  it("aceita a decisão de pular o aquecimento", () => {
    const r = pacingKnobsUpdateSchema.safeParse({ channel_session_id: SESSAO, skip_warmup: true });
    expect(r.success).toBe(true);
  });

  it("continua estrito: campo desconhecido é recusado", () => {
    const r = pacingKnobsUpdateSchema.safeParse({ channel_session_id: SESSAO, inventado: 1 });
    expect(r.success).toBe(false);
  });
});

describe("idade do número", () => {
  it("conta dias completos desde a ativação", () => {
    const row = { ...VAZIO, number_activated_at: "2026-04-29T02:00:00.000Z" };
    expect(idadeEmDias(row, new Date("2026-08-06T02:00:00.000Z"))).toBe(99);
  });

  it("sem data = idade 0 — o motor falha fechado, e a view não inventa idade", () => {
    expect(idadeEmDias(VAZIO)).toBe(0);
  });

  it("data no futuro não vira idade negativa", () => {
    const row = { ...VAZIO, number_activated_at: "2030-01-01T00:00:00.000Z" };
    expect(idadeEmDias(row, new Date("2026-08-06T00:00:00.000Z"))).toBe(0);
  });
});

describe("knobsView.warmup — o número que a tela precisava mostrar", () => {
  it("número recém-pareado: teto de hoje é o do primeiro degrau, NÃO o teto diário", () => {
    const hoje = new Date("2026-08-06T20:00:00.000Z");
    const row = { ...VAZIO, number_activated_at: "2026-08-06T19:00:00.000Z" };
    const v = knobsView(row, hoje);
    expect(v.warmup.age_days).toBe(0);
    expect(v.warmup.cap_today).toBe(20);
    expect(v.warmup.skipped).toBe(false);
  });

  it("número com mais de 31 dias: sem teto de aquecimento", () => {
    const v = knobsView(
      { ...VAZIO, number_activated_at: "2026-04-29T02:00:00.000Z" },
      new Date("2026-08-06T02:00:00.000Z"),
    );
    expect(v.warmup.cap_today).toBeNull();
  });

  it("aquecimento pulado: sem teto mesmo com o número nascido hoje", () => {
    const hoje = new Date("2026-08-06T20:00:00.000Z");
    const row = {
      ...VAZIO,
      number_activated_at: "2026-08-06T19:00:00.000Z",
      warmup_daily_caps: [...WARMUP_PULADO],
    };
    const v = knobsView(row, hoje);
    expect(v.warmup.age_days).toBe(0);
    expect(v.warmup.skipped).toBe(true);
    expect(v.warmup.cap_today).toBeNull();
  });
});

describe("warmupEstaPulado", () => {
  it("reconhece a forma gravada por skip_warmup", () => {
    expect(warmupEstaPulado({ ...VAZIO, warmup_daily_caps: [...WARMUP_PULADO] })).toBe(true);
  });

  it("os degraus padrão NÃO são 'pulado'", () => {
    expect(warmupEstaPulado(VAZIO)).toBe(false);
  });

  it("degraus customizados com teto não contam como pulado", () => {
    const row = { ...VAZIO, warmup_daily_caps: [{ minAgeDays: 0, cap: 500 }] };
    expect(warmupEstaPulado(row)).toBe(false);
  });
});
