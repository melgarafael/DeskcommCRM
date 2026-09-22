import { describe, expect, it, vi } from "vitest";

import {
  buildOpenAiRealtimeSession,
  createOpenAiRealtimeClientSecret,
} from "./openai-realtime";

const settings = {
  voice_id: "legacy-elevenlabs-voice",
  language: "pt" as const,
  first_message: "Olá, aqui é a Clara. Como posso ajudar?",
  system_prompt: "Você é Clara e atende clientes com objetividade e cordialidade.",
  max_duration_seconds: 300,
};

describe("sessão OpenAI Realtime 2.1", () => {
  it("fixa o modelo e PCM 24 kHz sem herdar a voz da ElevenLabs", () => {
    const session = buildOpenAiRealtimeSession("Clara", settings);

    expect(session.model).toBe("gpt-realtime-2.1");
    expect(session.output_modalities).toEqual(["audio"]);
    expect(session.audio.input.format).toEqual({ type: "audio/pcm", rate: 24_000 });
    expect(session.audio.output.format).toEqual({ type: "audio/pcm", rate: 24_000 });
    expect(session.audio.output.voice).toBe("marin");
    expect(session.instructions).toContain(settings.system_prompt);
    expect(session.instructions).toContain(settings.first_message);
  });

  it("cria segredo efêmero sem devolver a chave permanente", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        value: "ek_ephemeral_fixture",
        expires_at: 1_800_000_000,
        session: { id: "sess_fixture" },
      }),
    );

    const result = await createOpenAiRealtimeClientSecret({
      apiKey: "sk-permanent-fixture",
      safetyIdentifier: "safe_fixture",
      session: buildOpenAiRealtimeSession("Clara", settings),
      fetcher,
    });

    expect(result).toEqual({
      client_secret: "ek_ephemeral_fixture",
      expires_at: 1_800_000_000,
      websocket_url: "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1",
    });
    expect(JSON.stringify(result)).not.toContain("sk-permanent-fixture");
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/client_secrets",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("converte erro do provedor em mensagem segura", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ error: { message: "Incorrect API key provided: sk-secret" } }, { status: 401 }),
    );

    await expect(
      createOpenAiRealtimeClientSecret({
        apiKey: "sk-secret",
        safetyIdentifier: "safe_fixture",
        session: buildOpenAiRealtimeSession("Clara", settings),
        fetcher,
      }),
    ).rejects.toThrow("Não foi possível iniciar o OpenAI Realtime");
  });
});
