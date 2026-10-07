import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MediaRenderer } from "@/components/inbox/media/MediaRenderer";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import { MARCADOR_NAO_LIDA } from "@/lib/messaging/media/derivable";
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

// Um dia depois da chegada: fora do teto do "Transcrevendo…", como estes
// casos sempre renderizaram (o relógio virou prop no #2154).
const UM_DIA_DEPOIS = Date.parse("2026-07-21T20:00:00.000Z") + 24 * 60 * 60_000;

describe("MediaRenderer", () => {
  it("image → ImageMedia", () => {
    render(<MediaRenderer agora={UM_DIA_DEPOIS} message={msg({ type: "image" })} />);
    expect(screen.getByAltText("Imagem recebida")).toBeInTheDocument();
  });
  it("sticker → StickerMedia", () => {
    render(<MediaRenderer agora={UM_DIA_DEPOIS} message={msg({ type: "sticker" })} />);
    expect(screen.getByAltText("Figurinha")).toBeInTheDocument();
  });
  it("audio → AudioPlayer", () => {
    render(<MediaRenderer agora={UM_DIA_DEPOIS} message={msg({ type: "audio" })} />);
    expect(screen.getByRole("button", { name: /reproduzir/i })).toBeInTheDocument();
  });
  it("video → VideoMedia", () => {
    const { container } = render(<MediaRenderer agora={UM_DIA_DEPOIS} message={msg({ type: "video" })} />);
    expect(container.querySelector("video")).not.toBeNull();
  });
  it("document (e tipos desconhecidos) → DocumentCard", () => {
    render(<MediaRenderer agora={UM_DIA_DEPOIS} message={msg({ type: "document", media_mime: "application/pdf" })} />);
    expect(screen.getByRole("link", { name: /baixar pdf/i })).toBeInTheDocument();
  });
});

describe("MediaRenderer — transcrição do áudio no balão (#2057)", () => {
  const audio = (over: Partial<Message>) =>
    render(<MediaRenderer agora={UM_DIA_DEPOIS} message={msg({ type: "audio", ...over })} />);

  it("'ready' com texto mostra a transcrição abaixo do player", () => {
    audio({ media_derived_status: "ready", media_derived_text: "  oi, quero agendar  " });
    expect(screen.getByTestId("transcricao-de-audio")).toHaveTextContent("oi, quero agendar");
  });
  it.each([
    ["sem derivação", { media_derived_status: null, media_derived_text: null }],
    ["'ready' sem texto", { media_derived_status: "ready", media_derived_text: "   " }],
    ["'failed'", { media_derived_status: "failed", media_derived_text: "texto qualquer" }],
    ["'skipped'", { media_derived_status: "skipped", media_derived_text: "texto qualquer" }],
  ] as const)("%s esconde o bloco", (_, over) => {
    audio(over);
    expect(screen.queryByTestId("transcricao-de-audio")).not.toBeInTheDocument();
  });
  it("o aviso de mídia não lida, mesmo com 'ready', não aparece como transcrição", () => {
    audio({ media_derived_status: "ready", media_derived_text: MARCADOR_NAO_LIDA });
    expect(screen.queryByTestId("transcricao-de-audio")).not.toBeInTheDocument();
  });
  it("no balão enviado o texto herda a cor do balão (sem text-muted-foreground)", () => {
    audio({ direction: "outbound", media_derived_status: "ready", media_derived_text: "enviado" });
    expect(screen.getByTestId("transcricao-de-audio").className).not.toMatch(/text-muted-foreground/);
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
