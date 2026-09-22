type AgentCommand =
  | { user_audio_chunk: string }
  | { type: "pong"; event_id: number };

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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Traduz somente o protocolo de áudio entre o DataChannel PCM do WaCalls e o
 * WebSocket do ElevenLabs. Transporte e ciclo de vida ficam no hook global.
 */
export function createAiWacallsRelay(options: RelayOptions) {
  return {
    fromWacalls(pcm: ArrayBuffer) {
      options.sendAgent({ user_audio_chunk: bytesToBase64(pcm) });
    },

    fromAgent(raw: string) {
      let event: Record<string, unknown>;
      try {
        event = asRecord(JSON.parse(raw));
      } catch {
        options.onFailure?.("voice_agent_invalid_event");
        return;
      }

      if (event.type === "ping") {
        const ping = asRecord(event.ping_event);
        if (typeof ping.event_id === "number") {
          options.sendAgent({ type: "pong", event_id: ping.event_id });
        }
        return;
      }

      if (event.type === "conversation_initiation_metadata") {
        const metadata = asRecord(event.conversation_initiation_metadata_event);
        if (
          metadata.user_input_audio_format !== "pcm_16000" ||
          metadata.agent_output_audio_format !== "pcm_16000"
        ) {
          options.onFailure?.("voice_audio_format_mismatch");
          return;
        }
        if (typeof metadata.conversation_id === "string") {
          options.onReady?.(metadata.conversation_id);
        }
        return;
      }

      if (event.type === "audio") {
        const audio = asRecord(event.audio_event);
        if (typeof audio.audio_base_64 === "string" && audio.audio_base_64.length > 0) {
          options.sendWacalls(base64ToBuffer(audio.audio_base_64));
        }
        return;
      }

      if (event.type === "user_transcript") {
        const transcript = asRecord(event.user_transcription_event);
        if (typeof transcript.user_transcript === "string") {
          options.onTranscript?.("contact", transcript.user_transcript);
        }
        return;
      }

      if (event.type === "agent_response") {
        const response = asRecord(event.agent_response_event);
        if (typeof response.agent_response === "string") {
          options.onTranscript?.("agent", response.agent_response);
        }
      }
    },
  };
}
