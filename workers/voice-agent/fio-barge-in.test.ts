import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("ws", async () => {
  const { EventEmitter: Emissor } = await import("node:events");
  class FakeWs extends Emissor {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
    constructor() {
      super();
      ultimoWs.atual = this;
    }
  }
  return { default: FakeWs };
});
const ultimoWs = vi.hoisted(() => ({ atual: null as (EventEmitter & { send: ReturnType<typeof vi.fn> }) | null }));

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
  const sock = socketDeBrinquedo();
  ponte = new AudioSocketCallBridge(sock as never, {
    callId: "call-barge",
    organizationId: "org1",
    agentInstructions: "",
    voice: "coral",
    voiceSpeed: 1,
    voiceModel: "gpt-realtime-mini",
    onTranscriptTurn: () => {},
    onCallEnded: () => {},
    knowledgeSourceIdsPromise: Promise.resolve([]),
    searchKnowledge: async () => ({ trechos: [] }),
  });
  return { ponte, ws: ultimoWs.atual!, sock };
}

describe("ponte de voz: barge-in", () => {
  it("limpa fila, envia response.cancel e descarta deltas atrasados ao detectar fala do cliente", () => {
    const { ponte: b, ws } = abrir();
    const interno = b as unknown as { outboundQueue: Buffer };

    ws.emit("message", JSON.stringify({ type: "response.created" }));
    ws.emit("message", JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.alloc(160, 0xff).toString("base64") }));
    expect(interno.outboundQueue.length).toBeGreaterThan(0);

    ws.emit("message", JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    expect(interno.outboundQueue.length).toBe(0);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "response.cancel" }));

    // Delta atrasado da resposta cancelada deve ser descartado
    ws.emit("message", JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.alloc(160, 0xff).toString("base64") }));
    expect(interno.outboundQueue.length).toBe(0);

    // Próxima resposta volta a enfileirar áudio normalmente
    ws.emit("message", JSON.stringify({ type: "response.created" }));
    ws.emit("message", JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.alloc(160, 0xff).toString("base64") }));
    expect(interno.outboundQueue.length).toBeGreaterThan(0);
  });

  it("não envia response.cancel quando a IA não está falando nem com áudio na fila", () => {
    const { ws } = abrir();
    ws.emit("message", JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    expect(ws.send).not.toHaveBeenCalledWith(JSON.stringify({ type: "response.cancel" }));
  });
});
