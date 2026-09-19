/**
 * A JANELA DE ENVIO DE QUEM NUNCA ESCOLHEU FUSO NO NÚMERO É A DA ORGANIZAÇÃO.
 *
 * Medido numa instalação real (organização em `Europe/Lisbon`, número sem linha
 * em `channel_knobs`): a janela 7h–22h era avaliada em `America/Sao_Paulo`, o
 * literal de `PACING_DEFAULTS`. Em Lisboa isso é 11h–02h — o agente adiava até
 * as 11h a resposta a quem escreveu às 9h, e podia escrever às 2h da manhã.
 *
 * O instante de todos os casos é o mesmo: 08:00Z de um dia de julho, que é
 * 09:00 em Lisboa (WEST, UTC+1) e 05:00 em São Paulo (UTC-3). A janela padrão
 * 7h–22h está ABERTA num e FECHADA no outro — então cada caso só passa se o
 * fuso lido for o da organização.
 */
import { describe, expect, it } from "vitest";

import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { janelaDeEnvioAberta } from "@/lib/agent-engine/pacing/engine";
import { fusoDaJanela, loadChannelKnobs } from "@/lib/agent-engine/pacing/store";
import { effectiveKnobs } from "@/lib/ai/pacing-knobs";
import { adiarAteAJanelaAbrir } from "@/lib/automation/janela-do-canal";

const NOVE_DE_LISBOA = new Date("2026-07-17T08:00:00Z");
const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";

/** O que o `left join` devolve para um número que nunca teve a ficha salva. */
const SEM_KNOBS = {
  throttle_ms: null,
  jitter_max_ms: null,
  window_start_hour: null,
  window_end_hour: null,
  allow_sunday: null,
  timezone: null,
  warmup_daily_caps: null,
  number_activated_at: null,
};

describe("a escada do fuso: número → organização → padrão", () => {
  it("o fuso escolhido no número vence", () => {
    expect(fusoDaJanela("Asia/Tokyo", "Europe/Lisbon")).toBe("Asia/Tokyo");
  });

  it("sem fuso no número, vale o da organização", () => {
    expect(fusoDaJanela(null, "Europe/Lisbon")).toBe("Europe/Lisbon");
  });

  it("fuso da organização que o Intl recusa cai no padrão, em vez de derrubar o envio", () => {
    expect(fusoDaJanela(null, "Europe/Lisboa")).toBe(PACING_DEFAULTS.timezone);
    expect(fusoDaJanela(null, "  ")).toBe(PACING_DEFAULTS.timezone);
    expect(fusoDaJanela(undefined, undefined)).toBe(PACING_DEFAULTS.timezone);
  });
});

describe("o motor (resposta do agente e envio)", () => {
  it("às 9h de Lisboa a janela está aberta para uma organização de Lisboa sem knobs", async () => {
    const db = { query: async () => ({ rows: [{ ...SEM_KNOBS, org_timezone: "Europe/Lisbon" }] }) };
    const { knobs } = await loadChannelKnobs(db as never, ORG, CANAL);
    expect(knobs.timezone).toBe("Europe/Lisbon");
    expect(janelaDeEnvioAberta(NOVE_DE_LISBOA, knobs)).toBe(true);
  });

  it("e a organização de São Paulo segue fechada no mesmo instante — nada muda para ela", async () => {
    const db = { query: async () => ({ rows: [{ ...SEM_KNOBS, org_timezone: "America/Sao_Paulo" }] }) };
    const { knobs } = await loadChannelKnobs(db as never, ORG, CANAL);
    expect(janelaDeEnvioAberta(NOVE_DE_LISBOA, knobs)).toBe(false);
  });
});

describe("a automação", () => {
  /** Dublê que responde por TABELA — o fuso vem de uma, os knobs de outra. */
  function admin(porTabela: Record<string, unknown>) {
    return {
      from: (tabela: string) => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: porTabela[tabela] ?? null, error: null }),
        };
        return chain;
      },
    } as never;
  }

  it("às 9h de Lisboa envia na hora, sem linha em channel_knobs", async () => {
    const db = admin({ organizations: { timezone: "Europe/Lisbon" } });
    expect(await adiarAteAJanelaAbrir(db, ORG, CANAL, NOVE_DE_LISBOA)).toBeNull();
  });
});

describe("a tela (Conexões › Proteção de envio)", () => {
  it("'Usar o padrão' anuncia o fuso em que o motor de fato avalia", () => {
    expect(effectiveKnobs(null, "Europe/Lisbon").timezone).toBe("Europe/Lisbon");
  });
});
