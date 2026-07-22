import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DocumentCard } from "@/components/inbox/media/DocumentCard";
import { VideoMedia } from "@/components/inbox/media/VideoMedia";

describe("VideoMedia", () => {
  it("renderiza <video> com controles apontando pro endpoint", () => {
    const { container } = render(<VideoMedia messageId="m4" />);
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute("src", "/api/v1/messages/m4/media");
    expect(video).toHaveAttribute("controls");
  });

  it("mostra fallback quando o vídeo falha", () => {
    const { container } = render(<VideoMedia messageId="m4" />);
    fireEvent.error(container.querySelector("video")!);
    expect(screen.getByText("Mídia indisponível")).toBeInTheDocument();
  });
});

describe("DocumentCard", () => {
  it("mostra rótulo, tamanho e link de download", () => {
    render(
      <DocumentCard
        messageId="m5"
        mime="application/pdf"
        sizeBytes={3179614}
        storagePath="org/conv/m5.pdf"
        isOutbound={false}
      />,
    );
    expect(screen.getByText("PDF")).toBeInTheDocument();
    expect(screen.getByText(/3,0 MB/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /baixar documento/i });
    expect(link).toHaveAttribute("href", "/api/v1/messages/m5/media");
    expect(link).toHaveAttribute("target", "_blank");
  });
});
