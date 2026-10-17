import { describe, expect, it } from "vitest";

import { adiamentoPorRitmo } from "./ritmo-do-texto-fixo";
import { decidirEspacamento } from "@/lib/agent-engine/pacing/ledger-supabase";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";

/**
 * O freio anti-ban do texto fixo. Os casos abaixo medem a TRADUÇÃO do veredito
 * para o vocabulário de adiamento do follow-up, e a composição com a regra real
 * (`decidirEspacamento`) — não uma segunda régua.
 *
 * Por que importa: o passo de texto fixo chamava `sendMessageHandler` direto,
 * por fora da cadeia `before_send`, logo sem espaçamento, jitter, warm-up nem
 * teto diário. Um fluxo que inscrevesse muita gente de uma vez mandava em
 * rajada pelo mesmo número.
 */
const BASE = {
  timezone: "America/Sao_Paulo",
  throttleMs: PACING_DEFAULTS.throttleMs,
  jitterMaxMs: PACING_DEFAULTS.jitterMaxMs,
  warmupDailyCaps: PACING_DEFAULTS.warmupDailyCaps,
  rng: () => 0,
};

describe("adiamentoPorRitmo", () => {
  it("liberado → null (envia agora)", () => {
    expect(adiamentoPorRitmo({ liberado: true })).toBeNull();
  });

  it("teto_diario → daily_cap, o MESMO código do caminho do worker", () => {
    const liberaEm = new Date("2026-10-16T03:00:00Z");
    expect(adiamentoPorRitmo({ liberado: false, motivo: "teto_diario", liberaEm })).toEqual({
      until: liberaEm,
      reason: "daily_cap",
    });
  });

  it("espacamento → pacing_throttle", () => {
    const liberaEm = new Date("2026-10-15T12:00:01.200Z");
    expect(adiamentoPorRitmo({ liberado: false, motivo: "espacamento", liberaEm })).toEqual({
      until: liberaEm,
      reason: "pacing_throttle",
    });
  });
});

describe("adiamentoPorRitmo sobre a regra real", () => {
  const agora = new Date("2026-10-15T15:00:00Z");

  it("número novo que já bateu o teto de warm-up (20/dia) adia até a virada local", () => {
    const decisao = decidirEspacamento({
      ...BASE,
      agora,
      estado: { lastSentAt: null, sentToday: 20, numberActivatedAt: agora },
      crmDailyLimit: null,
    });
    const adiamento = adiamentoPorRitmo(decisao);

    expect(adiamento?.reason).toBe("daily_cap");
    // Não é `agora + 24h`: é a meia-noite LOCAL seguinte, quando o contador zera.
    expect(adiamento!.until.getTime()).toBeGreaterThan(agora.getTime());
  });

  it("envio há 200 ms adia pelo espaçamento de 1,2 s, não pelo teto", () => {
    const decisao = decidirEspacamento({
      ...BASE,
      agora,
      estado: {
        lastSentAt: new Date(agora.getTime() - 200),
        sentToday: 1,
        numberActivatedAt: new Date("2026-01-01T00:00:00Z"),
      },
      crmDailyLimit: null,
    });
    const adiamento = adiamentoPorRitmo(decisao);

    expect(adiamento?.reason).toBe("pacing_throttle");
    expect(adiamento!.until.getTime()).toBe(agora.getTime() - 200 + PACING_DEFAULTS.throttleMs);
  });

  it("número formado, dentro do teto e espaçado: libera", () => {
    const decisao = decidirEspacamento({
      ...BASE,
      agora,
      estado: {
        lastSentAt: new Date(agora.getTime() - 60_000),
        sentToday: 3,
        numberActivatedAt: new Date("2026-01-01T00:00:00Z"),
      },
      crmDailyLimit: 1000,
    });

    expect(adiamentoPorRitmo(decisao)).toBeNull();
  });

  it("o teto do CRM é respeitado mesmo com o número formado", () => {
    const decisao = decidirEspacamento({
      ...BASE,
      agora,
      estado: {
        lastSentAt: null,
        sentToday: 50,
        numberActivatedAt: new Date("2026-01-01T00:00:00Z"),
      },
      crmDailyLimit: 50,
    });

    expect(adiamentoPorRitmo(decisao)?.reason).toBe("daily_cap");
  });
});
