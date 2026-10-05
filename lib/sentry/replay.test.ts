import { describe, expect, it, vi } from "vitest";

import {
  integracoesDeReplay,
  limparEventoDeGravacao,
  pararReplayEmRotaComCredencial,
  replayEventSemUrlCrua,
} from "./replay";
import { sentryScrubHooks, urlComCredencial } from "./scrub";

const TOKEN = "convite9f3a1c8b2e4d6a0f";
const HASH = "pkce_7b1e0c9d2a4f";
const CONVITE = `https://crm.exemplo.com/team/accept-invite/${TOKEN}`;
const CONTINUAR = `https://crm.exemplo.com/login/continuar?token_hash=${HASH}&type=recovery`;
const COMUM = "https://crm.exemplo.com/app/inbox?aba=minhas";

function semCredencial(valor: unknown): void {
  const texto = JSON.stringify(valor);
  expect(texto).not.toContain(TOKEN);
  expect(texto).not.toContain(HASH);
}

describe("urlComCredencial", () => {
  it("reconhece credencial no path e em parâmetro de query ou de fragmento", () => {
    expect(urlComCredencial(CONVITE)).toBe(true);
    expect(urlComCredencial(CONTINUAR)).toBe(true);
    expect(urlComCredencial(`/team/accept-invite/${TOKEN}`)).toBe(true);
    expect(urlComCredencial(`/login/continuar?token_hash=${HASH}`)).toBe(true);
    expect(urlComCredencial(`https://crm.exemplo.com/x#code=${HASH}`)).toBe(true);
  });

  it("não acusa a página comum — o Replay segue gravando nela", () => {
    expect(urlComCredencial(COMUM)).toBe(false);
    expect(urlComCredencial("/app/leads/0b6f1c1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f")).toBe(false);
  });
});

describe("integracoesDeReplay", () => {
  it("na página com credencial na URL, não há Replay", () => {
    const criar = vi.fn();
    expect(integracoesDeReplay(CONVITE, criar)).toEqual([]);
    expect(integracoesDeReplay(CONTINUAR, criar)).toEqual([]);
    expect(criar).not.toHaveBeenCalled();
  });

  it("na página comum, Replay com o scrub nos eventos de gravação e no replay_event", () => {
    const criar = vi.fn((opcoes: unknown) => ({ name: "Replay", opcoes }));
    const saida = integracoesDeReplay(COMUM, criar);
    expect(criar).toHaveBeenCalledWith({ beforeAddRecordingEvent: limparEventoDeGravacao });
    expect(saida).toContain(replayEventSemUrlCrua);
  });
});

describe("pararReplayEmRotaComCredencial", () => {
  it("navegar para a página com credencial para o Replay; para a comum, não", () => {
    const replay = { stop: vi.fn(async () => {}) };
    pararReplayEmRotaComCredencial("/app/inbox", replay);
    expect(replay.stop).not.toHaveBeenCalled();
    pararReplayEmRotaComCredencial(`/team/accept-invite/${TOKEN}`, replay);
    expect(replay.stop).toHaveBeenCalledTimes(1);
  });
});

describe("limparEventoDeGravacao (beforeAddRecordingEvent)", () => {
  it("limpa a URL do span de navegação e a da página anterior", () => {
    const evento = limparEventoDeGravacao({
      type: 5,
      data: {
        tag: "performanceSpan",
        payload: { op: "navigation.push", description: CONTINUAR, data: { previous: CONVITE } },
      },
    });
    semCredencial(evento);
  });

  it("limpa o breadcrumb de navegação gravado no Replay", () => {
    const evento = limparEventoDeGravacao({
      type: 5,
      data: { tag: "breadcrumb", payload: { category: "navigation", data: { from: CONVITE, to: CONTINUAR } } },
    });
    semCredencial(evento);
  });
});

describe("replayEventSemUrlCrua (o replay_event não passa pelo beforeSend)", () => {
  it("limpa urls, request.url e Referer", () => {
    const evento = replayEventSemUrlCrua.processEvent({
      type: "replay_event",
      urls: [CONVITE, CONTINUAR],
      request: { url: CONTINUAR, headers: { Referer: CONVITE, "User-Agent": "Mozilla/5.0" } },
    });
    semCredencial(evento);
    expect(evento.request?.headers).toMatchObject({ "User-Agent": "Mozilla/5.0" });
  });
});

describe("beforeBreadcrumb", () => {
  it("limpa from/to da navegação, que também vai no evento de erro", () => {
    semCredencial(
      sentryScrubHooks.beforeBreadcrumb({ data: { from: CONVITE, to: CONTINUAR } }),
    );
  });
});
