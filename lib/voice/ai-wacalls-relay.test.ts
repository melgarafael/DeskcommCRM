import { describe, expect, it, vi } from "vitest";

import { createAiWacallsRelay } from "./ai-wacalls-relay";

describe("ponte de audio IA com WaCalls", () => {
  it("converte o PCM 16 kHz do WaCalls para 24 kHz e usa o evento GA da OpenAI", () => {
    const sendAgent = vi.fn();
    const relay = createAiWacallsRelay({ sendAgent, sendWacalls: vi.fn() });

    relay.fromWacalls(new Int16Array([1000, 1000, 1000, 1000]).buffer);

    const command = sendAgent.mock.calls[0]![0];
    expect(command.type).toBe("input_audio_buffer.append");
    expect(atob(command.audio).length).toBe(10);
  });

  it("converte o PCM 24 kHz da OpenAI para 16 kHz e devolve ao WaCalls", () => {
    const sendWacalls = vi.fn();
    const relay = createAiWacallsRelay({ sendAgent: vi.fn(), sendWacalls });
    const pcm24 = new Int16Array([1000, 1000, 1000, 1000, 1000, 1000]);
    const bytes = new Uint8Array(pcm24.buffer);
    const encoded = btoa(String.fromCharCode(...bytes));

    relay.fromAgent(JSON.stringify({
      type: "response.output_audio.delta",
      delta: encoded,
    }));

    expect(new Int16Array(sendWacalls.mock.calls[0]![0]).length).toBe(4);
  });

  it("sinaliza prontidão e propaga erro da sessão Realtime", () => {
    const sendAgent = vi.fn();
    const onReady = vi.fn();
    const onFailure = vi.fn();
    const relay = createAiWacallsRelay({ sendAgent, sendWacalls: vi.fn(), onReady, onFailure });

    relay.fromAgent(JSON.stringify({ type: "session.created", session: { id: "sess_1" } }));
    relay.fromAgent(JSON.stringify({ type: "error", error: { code: "invalid_event" } }));

    expect(onReady).toHaveBeenCalledWith("sess_1");
    expect(onFailure).toHaveBeenCalledWith("invalid_event");
  });
});
