import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { AudioPlayer } from "@/components/inbox/media/AudioPlayer";

beforeAll(() => {
  // jsdom não implementa playback — mocka o mínimo do HTMLMediaElement.
  Object.defineProperty(window.HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, "pause", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("AudioPlayer", () => {
  it("renderiza com src do endpoint e controles", () => {
    render(<AudioPlayer messageId="m3" isOutbound={false} />);
    expect(screen.getByRole("button", { name: /reproduzir/i })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: /progresso/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /velocidade/i })).toHaveTextContent("1x");
  });

  it("alterna play/pause", () => {
    render(<AudioPlayer messageId="m3" isOutbound={false} />);
    const btn = screen.getByRole("button", { name: /reproduzir/i });
    fireEvent.click(btn);
    expect(screen.getByRole("button", { name: /pausar/i })).toBeInTheDocument();
  });

  it("cicla a velocidade 1x → 1.5x → 2x → 1x", () => {
    render(<AudioPlayer messageId="m3" isOutbound={false} />);
    const rate = screen.getByRole("button", { name: /velocidade/i });
    fireEvent.click(rate);
    expect(rate).toHaveTextContent("1.5x");
    fireEvent.click(rate);
    expect(rate).toHaveTextContent("2x");
    fireEvent.click(rate);
    expect(rate).toHaveTextContent("1x");
  });
});
