import { describe, expect, it, vi } from "vitest";
import { normalizarVideoParaWhatsApp } from "@/lib/messaging/media/video-transcode";

describe("normalizarVideoParaWhatsApp", () => {
  const videoInput = {
    buffer: Buffer.from("fake-video-bytes-12345"),
    mime: "video/mp4",
  };

  it("chama ffmpeg com flags libx264, ultrafast e +faststart", async () => {
    const run = vi.fn(async (_args: string[], _cwd: string) => {});
    await normalizarVideoParaWhatsApp(videoInput, { run });
    expect(run).toHaveBeenCalled();
    const args = run.mock.calls[0]?.[0] ?? [];
    expect(args).toContain("libx264");
    expect(args).toContain("ultrafast");
    expect(args).toContain("+faststart");
    expect(args).toContain("aac");
  });

  it("não tenta converter se o buffer for vazio", async () => {
    const run = vi.fn(async () => {});
    const r = await normalizarVideoParaWhatsApp({ buffer: Buffer.alloc(0), mime: "video/mp4" }, { run });
    expect(run).not.toHaveBeenCalled();
    expect(r.convertido).toBe(false);
  });

  it("em caso de falha do ffmpeg, devolve o buffer original intacto", async () => {
    const run = vi.fn(async () => {
      throw new Error("ffmpeg error");
    });
    const r = await normalizarVideoParaWhatsApp(videoInput, { run });
    expect(r.convertido).toBe(false);
    expect(r.buffer).toEqual(videoInput.buffer);
    expect(r.mime).toBe("video/mp4");
  });
});
