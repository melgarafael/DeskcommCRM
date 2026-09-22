import { VoiceAssistantError, type VoiceSettings } from "./schema";

export const OPENAI_REALTIME_MODEL = "gpt-realtime-2.1" as const;
export const OPENAI_REALTIME_WEBSOCKET_URL =
  `wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}` as const;

const OPENAI_VOICES = new Set([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
]);

export interface OpenAiRealtimeSessionConfig {
  type: "realtime";
  model: typeof OPENAI_REALTIME_MODEL;
  output_modalities: ["audio"];
  instructions: string;
  audio: {
    input: {
      format: { type: "audio/pcm"; rate: 24_000 };
      transcription: { model: "gpt-4o-mini-transcribe"; language: VoiceSettings["language"] };
      turn_detection: {
        type: "server_vad";
        create_response: true;
        interrupt_response: true;
      };
    };
    output: {
      format: { type: "audio/pcm"; rate: 24_000 };
      voice: string;
    };
  };
}

export function buildOpenAiRealtimeSession(
  agentName: string,
  settings: VoiceSettings,
): OpenAiRealtimeSessionConfig {
  const voice = OPENAI_VOICES.has(settings.voice_id) ? settings.voice_id : "marin";
  return {
    type: "realtime",
    model: OPENAI_REALTIME_MODEL,
    output_modalities: ["audio"],
    instructions: [
      settings.system_prompt,
      `Você está em uma ligação telefônica e seu nome é ${agentName}.`,
      `Converse em ${settings.language === "pt" ? "português do Brasil" : settings.language === "es" ? "espanhol" : "inglês"}.`,
      `Na primeira resposta, cumprimente dizendo: ${settings.first_message}`,
      "Responda de forma natural, breve e adequada para voz. Não use markdown.",
    ].join("\n\n"),
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24_000 },
        transcription: { model: "gpt-4o-mini-transcribe", language: settings.language },
        turn_detection: {
          type: "server_vad",
          create_response: true,
          interrupt_response: true,
        },
      },
      output: {
        format: { type: "audio/pcm", rate: 24_000 },
        voice,
      },
    },
  };
}

interface CreateSecretInput {
  apiKey: string;
  safetyIdentifier: string;
  session: OpenAiRealtimeSessionConfig;
  fetcher?: typeof fetch;
}

interface ClientSecretResponse {
  value?: unknown;
  expires_at?: unknown;
}

export async function createOpenAiRealtimeClientSecret({
  apiKey,
  safetyIdentifier,
  session,
  fetcher = fetch,
}: CreateSecretInput): Promise<{
  client_secret: string;
  expires_at: number;
  websocket_url: typeof OPENAI_REALTIME_WEBSOCKET_URL;
}> {
  const response = await fetcher("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": safetyIdentifier,
    },
    body: JSON.stringify({ session }),
  });
  const payload = (await response.json().catch(() => null)) as ClientSecretResponse | null;
  if (
    !response.ok ||
    typeof payload?.value !== "string" ||
    typeof payload.expires_at !== "number"
  ) {
    throw new VoiceAssistantError(
      "Não foi possível iniciar o OpenAI Realtime. Verifique a chave e o acesso ao modelo.",
      response.status === 401 || response.status === 403 ? 409 : 502,
    );
  }
  return {
    client_secret: payload.value,
    expires_at: payload.expires_at,
    websocket_url: OPENAI_REALTIME_WEBSOCKET_URL,
  };
}
