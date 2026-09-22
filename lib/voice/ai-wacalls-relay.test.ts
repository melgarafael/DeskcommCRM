import { describe, expect, it, vi } from "vitest";

import { createAiWacallsRelay } from "./ai-wacalls-relay";

describe("ponte de audio IA com WaCalls", () => {
  it("envia o PCM recebido do WhatsApp como user_audio_chunk", () => {
    const sendAgent = vi.fn();
    const relay = createAiWacallsRelay({ sendAgent, sendWacalls: vi.fn() });

    relay.fromWacalls(new Uint8Array([0, 1, 254, 255]).buffer);

    expect(sendAgent).toHaveBeenCalledWith({ user_audio_chunk: "AAH+/w==" });
  });

  it("devolve o audio PCM do agente ao WaCalls", () => {
    const sendWacalls = vi.fn();
    const relay = createAiWacallsRelay({ sendAgent: vi.fn(), sendWacalls });

    relay.fromAgent(JSON.stringify({
      type: "audio",
      audio_event: { audio_base_64: "AAH+/w==", event_id: 7 },
    }));

    expect(Array.from(new Uint8Array(sendWacalls.mock.calls[0]![0]))).toEqual([0, 1, 254, 255]);
  });

  it("responde o ping do agente e recusa formato diferente de PCM 16 kHz", () => {
    const sendAgent = vi.fn();
    const onFailure = vi.fn();
    const relay = createAiWacallsRelay({ sendAgent, sendWacalls: vi.fn(), onFailure });

    relay.fromAgent(JSON.stringify({ type: "ping", ping_event: { event_id: 11 } }));
    relay.fromAgent(JSON.stringify({
      type: "conversation_initiation_metadata",
      conversation_initiation_metadata_event: {
        conversation_id: "conv_1",
        user_input_audio_format: "pcm_16000",
        agent_output_audio_format: "mp3_44100_128",
      },
    }));

    expect(sendAgent).toHaveBeenCalledWith({ type: "pong", event_id: 11 });
    expect(onFailure).toHaveBeenCalledWith("voice_audio_format_mismatch");
  });
});
