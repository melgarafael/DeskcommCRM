import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MediaRenderer } from "@/components/inbox/media/MediaRenderer";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import type { Message } from "@/lib/types/messaging";

function msg(over: Partial<Message>): Message {
  return {
    id: "m1",
    conversation_id: "c1",
    contact_id: "ct1",
    channel_session_id: "s1",
    external_id: "x1",
    type: "text",
    direction: "inbound",
    status: "delivered",
    ack: null,
    body: null,
    media_url: "http://waha/file",
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "external_device",
    sent_at: "2026-07-21T20:00:00.000Z",
    delivered_at: null,
    read_at: null,
    error_code: null,
    error_message: null,
    metadata: {},
    created_at: "2026-07-21T20:00:00.000Z",
    ...over,
  } as Message;
}

describe("MediaRenderer", () => {
  it("image → ImageMedia", () => {
    render(<MediaRenderer message={msg({ type: "image" })} />);
    expect(screen.getByAltText("Imagem recebida")).toBeInTheDocument();
  });
  it("sticker → StickerMedia", () => {
    render(<MediaRenderer message={msg({ type: "sticker" })} />);
    expect(screen.getByAltText("Figurinha")).toBeInTheDocument();
  });
  it("audio → AudioPlayer", () => {
    render(<MediaRenderer message={msg({ type: "audio" })} />);
    expect(screen.getByRole("button", { name: /reproduzir/i })).toBeInTheDocument();
  });
  it("video → VideoMedia", () => {
    const { container } = render(<MediaRenderer message={msg({ type: "video" })} />);
    expect(container.querySelector("video")).not.toBeNull();
  });
  it("document (e tipos desconhecidos) → DocumentCard", () => {
    render(<MediaRenderer message={msg({ type: "document", media_mime: "application/pdf" })} />);
    expect(screen.getByRole("link", { name: /baixar pdf/i })).toBeInTheDocument();
  });
});

describe("MessageBubble com mídia", () => {
  it("renderiza mídia E caption juntos", () => {
    render(<MessageBubble message={msg({ type: "image", body: "olha isso" })} />);
    expect(screen.getByAltText("Imagem recebida")).toBeInTheDocument();
    expect(screen.getByText("olha isso")).toBeInTheDocument();
  });
  it("mensagem só-texto não renderiza mídia", () => {
    render(<MessageBubble message={msg({ type: "text", body: "oi", media_url: null })} />);
    expect(screen.queryByAltText("Imagem recebida")).not.toBeInTheDocument();
  });
});
