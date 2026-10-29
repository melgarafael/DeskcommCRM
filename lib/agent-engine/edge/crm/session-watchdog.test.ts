import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CORPO_DO_GO_LIVE, TITULO_DO_GO_LIVE, textoDoGoLive } from "../../health/circuit";
import { PACING_DEFAULTS } from "../../pacing/defaults";
import { INTERVALO_ENTRE_RETIDOS_MS, espacarRetidos } from "./session-watchdog";

const iso = (d: Date[]): string[] => d.map((x) => x.toISOString());

describe("espacarRetidos: os retornos liberados não saem todos no mesmo instante (doc 109)", () => {
  it("os já vencidos saem um a cada intervalo, a partir de agora", () => {
    const agora = new Date("2026-10-06T15:00:00Z"); // 12h em São Paulo
    const devidos = [
      new Date("2026-10-06T13:00:00Z"),
      new Date("2026-10-06T14:00:00Z"),
      new Date("2026-10-06T14:00:00Z"),
    ];
    expect(iso(espacarRetidos(devidos, agora, PACING_DEFAULTS))).toEqual([
      "2026-10-06T15:00:00.000Z",
      "2026-10-06T15:05:00.000Z",
      "2026-10-06T15:10:00.000Z",
    ]);
    expect(INTERVALO_ENTRE_RETIDOS_MS).toBe(5 * 60_000);
  });

  it("o que cairia fora da janela de disparo vai para a abertura dela, e não se amontoa", () => {
    const agora = new Date("2026-10-07T00:50:00Z"); // 21h50 em São Paulo; a janela fecha às 22h
    const devidos = [1, 2, 3, 4].map(() => new Date("2026-10-06T20:00:00Z"));
    expect(iso(espacarRetidos(devidos, agora, PACING_DEFAULTS))).toEqual([
      "2026-10-07T00:50:00.000Z",
      "2026-10-07T00:55:00.000Z",
      "2026-10-07T10:00:00.000Z", // 7h do dia seguinte
      "2026-10-07T10:05:00.000Z",
    ]);
  });

  it("o que ainda não venceu mantém o próprio horário", () => {
    const agora = new Date("2026-10-06T15:00:00Z");
    const devidos = [new Date("2026-10-06T14:00:00Z"), new Date("2026-10-06T18:00:00Z")];
    expect(iso(espacarRetidos(devidos, agora, PACING_DEFAULTS))).toEqual([
      "2026-10-06T15:00:00.000Z",
      "2026-10-06T18:00:00.000Z",
    ]);
  });
});

describe("o item da trava de número novo diz que os retornos pararam", () => {
  it("em português, espanhol e no catálogo em inglês", () => {
    expect(TITULO_DO_GO_LIVE).toBe("Número novo aguardando liberação (go-live)");
    expect(CORPO_DO_GO_LIVE).toContain("Os retornos automáticos deste número estão parados até você liberar");
    const es = textoDoGoLive("es");
    expect(es.title).toBe("Número nuevo en espera de liberación (go-live)");
    expect(es.body).toContain("están detenidos hasta que lo liberes");
    const en = JSON.parse(readFileSync("lib/i18n/traducoes/en.json", "utf8")) as Record<string, string>;
    expect(en[TITULO_DO_GO_LIVE]).toBe("New number awaiting release (go-live)");
    expect(en[CORPO_DO_GO_LIVE]).toContain("paused until you release it");
  });
});
