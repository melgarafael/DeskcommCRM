import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Message } from "@/lib/types/messaging";
import { MediaRenderer } from "./MediaRenderer";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));

const audioPlayerSpy = vi.fn((props: Record<string, unknown>) => (
  <pre data-testid="audio-player-props">{JSON.stringify(props)}</pre>
));

vi.mock("./AudioPlayer", () => ({
  AudioPlayer: (props: Record<string, unknown>) => audioPlayerSpy(props),
}));

function audioMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "message-1",
    organization_id: "org-1",
    conversation_id: "conversation-1",
    channel_session_id: "session-1",
    contact_id: "contact-1",
    external_id: "external-1",
    type: "audio",
    direction: "inbound",
    status: "delivered",
    ack: 2,
    error_code: null,
    error_message: null,
    body: null,
    media_url: "https://example.com/audio.ogg",
    media_mime: "audio/ogg",
    media_size_bytes: 128,
    media_storage_path: "messages/audio.ogg",
    media_derived_text: "Quero saber o preço do plano.",
    media_derived_status: "ready",
    audio_transcription: null,
    audio_transcription_status: "none",
    audio_summary: "Lead perguntou pelo preço.",
    audio_intent: "Dúvida sobre preço",
    sent_via: "external_device",
    sent_by_user_id: null,
    sent_at: "2026-09-22T00:00:00.000Z",
    delivered_at: null,
    read_at: null,
    metadata: {},
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("MediaRenderer audio com IA", () => {
  it("entrega ao player a transcrição real já produzida pelo motor", () => {
    render(<MediaRenderer message={audioMessage()} />);

    expect(screen.getByTestId("audio-player-props")).toHaveTextContent(
      '"transcription":"Quero saber o preço do plano."',
    );
    expect(audioPlayerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        transcription: "Quero saber o preço do plano.",
        transcriptionStatus: "ready",
        summary: "Lead perguntou pelo preço.",
        intent: "Dúvida sobre preço",
      }),
    );
  });

  it("prefere a transcrição editorial quando ela existir", () => {
    render(
      <MediaRenderer
        message={audioMessage({ audio_transcription: "Texto revisado pela operação." })}
      />,
    );

    expect(audioPlayerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ transcription: "Texto revisado pela operação." }),
    );
  });
});
