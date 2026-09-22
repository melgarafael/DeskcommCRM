type AgentCommand = { type: "input_audio_buffer.append"; audio: string };

interface RelayOptions {
  sendAgent(command: AgentCommand): void;
  sendWacalls(pcm: ArrayBuffer): void;
  onReady?: (conversationId: string) => void;
  onTranscript?: (speaker: "contact" | "agent", text: string) => void;
  onFailure?: (reason: string) => void;
}

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

/**
 * Reamostrador PCM16 contínuo. Guarda a fase e a última amostra entre quadros,
 * porque a OpenAI pode devolver blocos que não terminam num múltiplo exato da
 * razão 24 kHz -> 16 kHz.
 */
function createPcm16Resampler(inputRate: number, outputRate: number) {
  let pending: number[] = [];
  let position = 0;
  const step = inputRate / outputRate;

  return (buffer: ArrayBuffer): ArrayBuffer => {
    const bytes = buffer.byteLength - (buffer.byteLength % 2);
    if (bytes === 0) return new ArrayBuffer(0);
    const input = new Int16Array(buffer, 0, bytes / 2);
    pending.push(...input);
    const output: number[] = [];

    while (position + 1 < pending.length) {
      const left = Math.floor(position);
      const fraction = position - left;
      const interpolated = pending[left]! + (pending[left + 1]! - pending[left]!) * fraction;
      output.push(Math.max(-32768, Math.min(32767, Math.round(interpolated))));
      position += step;
    }

    const consumed = Math.floor(position);
    if (consumed > 0) {
      pending = pending.slice(consumed);
      position -= consumed;
    }
    return Int16Array.from(output).buffer;
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Traduz o protocolo e a taxa de amostragem entre o DataChannel PCM 16 kHz do
 * WaCalls e o WebSocket PCM 24 kHz do OpenAI Realtime. Transporte e ciclo de
 * vida ficam no hook global.
 */
export function createAiWacallsRelay(options: RelayOptions) {
  const toRealtime = createPcm16Resampler(16_000, 24_000);
  const toWacalls = createPcm16Resampler(24_000, 16_000);

  return {
    fromWacalls(pcm: ArrayBuffer) {
      const converted = toRealtime(pcm);
      if (converted.byteLength > 0) {
        options.sendAgent({
          type: "input_audio_buffer.append",
          audio: bytesToBase64(converted),
        });
      }
    },

    fromAgent(raw: string) {
      let event: Record<string, unknown>;
      try {
        event = asRecord(JSON.parse(raw));
      } catch {
        options.onFailure?.("voice_agent_invalid_event");
        return;
      }

      if (event.type === "session.created" || event.type === "session.updated") {
        const session = asRecord(event.session);
        if (typeof session.id === "string") {
          options.onReady?.(session.id);
        }
        return;
      }

      if (event.type === "response.output_audio.delta") {
        if (typeof event.delta === "string" && event.delta.length > 0) {
          const converted = toWacalls(base64ToBuffer(event.delta));
          if (converted.byteLength > 0) options.sendWacalls(converted);
        }
        return;
      }

      if (event.type === "conversation.item.input_audio_transcription.completed") {
        if (typeof event.transcript === "string") {
          options.onTranscript?.("contact", event.transcript);
        }
        return;
      }

      if (event.type === "response.output_audio_transcript.done") {
        if (typeof event.transcript === "string") {
          options.onTranscript?.("agent", event.transcript);
        }
        return;
      }

      if (event.type === "error") {
        const error = asRecord(event.error);
        options.onFailure?.(
          typeof error.code === "string" ? error.code : "voice_agent_realtime_error",
        );
      }
    },
  };
}
