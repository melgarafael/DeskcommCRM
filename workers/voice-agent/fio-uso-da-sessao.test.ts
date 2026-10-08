/**
 * O FIO: a ponte de voz soma o `usage` de cada `response.done` da OpenAI
 * Realtime e guarda o handshake recusado — é o que `finalizeAudioSocketCall`
 * (index.ts) grava em `llm_calls`. Função pura testada sozinha não prova que a
 * ponte a chama.
 */
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

// WebSocket de brinquedo: nenhum byte sai para a OpenAI.
vi.mock("ws", async () => {
  // Import dentro da fábrica: o `vi.mock` é içado acima dos imports do arquivo.
  const { EventEmitter: Emissor } = await import("node:events");
  class FakeWs extends Emissor {
    static OPEN = 1;
    readyState = 0;
    send = vi.fn();
    close = vi.fn();
    constructor() {
      super();
      ultimoWs.atual = this;
    }
  }
  return { default: FakeWs };
});
const ultimoWs = vi.hoisted(() => ({ atual: null as EventEmitter | null }));

import { AudioSocketCallBridge } from "./audioSocketBridge";

function socketDeBrinquedo() {
  const s = new EventEmitter() as EventEmitter & Record<string, unknown>;
  s.setNoDelay = vi.fn();
  s.write = vi.fn();
  s.end = vi.fn();
  s.destroyed = false;
  return s;
}

let ponte: AudioSocketCallBridge | null = null;
afterEach(() => {
  ponte?.close();
  ponte = null;
});

function abrir() {
  ponte = new AudioSocketCallBridge(socketDeBrinquedo() as never, {
    callId: "call1",
    organizationId: "org1",
    agentInstructions: "",
    voice: "marin",
    voiceSpeed: 1,
    voiceModel: "gpt-realtime",
    onTranscriptTurn: () => {},
    onCallEnded: () => {},
    knowledgeSourceIdsPromise: Promise.resolve([]),
    searchKnowledge: async () => ({ trechos: [] }),
  });
  return { ponte, ws: ultimoWs.atual! };
}

describe("ponte de voz: uso da sessão", () => {
  it("soma o usage de cada response.done", () => {
    const { ponte, ws } = abrir();
    const usage = {
      input_tokens: 100,
      output_tokens: 40,
      input_token_details: { audio_tokens: 90, text_tokens: 10, cached_tokens: 0 },
      output_token_details: { audio_tokens: 35, text_tokens: 5 },
    };
    ws.emit("message", Buffer.from(JSON.stringify({ type: "response.done", response: { output: [], usage } })));
    ws.emit("message", Buffer.from(JSON.stringify({ type: "response.done", response: { output: [], usage } })));

    const sessao = ponte.usoDaSessao();
    expect(sessao.modelo).toBe("gpt-realtime");
    expect(sessao.uso.respostas).toBe(2);
    expect(sessao.uso.entrada).toBe(200);
    expect(sessao.uso.saida).toBe(80);
    expect(sessao.uso.saidaAudio).toBe(70);
    expect(sessao.erro).toBeNull();
  });

  it("handshake recusado fica guardado como erro da sessão", async () => {
    const { ponte, ws } = abrir();
    const res = new EventEmitter() as EventEmitter & { statusCode?: number };
    res.statusCode = 401;
    ws.emit("unexpected-response", {}, res);
    res.emit("data", "invalid_api_key");
    res.emit("end");

    expect(ponte.usoDaSessao().erro).toEqual({
      message: "handshake rejeitado: invalid_api_key",
      status: 401,
    });
  });
});
