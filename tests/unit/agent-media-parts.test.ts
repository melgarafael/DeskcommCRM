import { describe, expect, it, vi } from "vitest";

import { buildNativeMediaParts } from "@/lib/agent-engine/agent/media-parts";

// Mock do admin storage: download() devolve um Blob com bytes (path embutido nos
// bytes p/ o teste de recência conseguir distinguir qual mídia foi baixada).
function signer(ok = true) {
  return {
    storage: {
      from: () => ({
        download: vi.fn(async (path: string) =>
          ok
            ? { data: new Blob([new TextEncoder().encode(path)]), error: null }
            : { data: null, error: { message: "x" } },
        ),
      }),
    },
  };
}

const imgMsg = { direction: "inbound" as const, body: "[image]", sent_at: "t", type: "image", media_storage_path: "org/conv/m.jpg", media_mime: "image/jpeg" };
const pdfMsg = { direction: "inbound" as const, body: "[document]", sent_at: "t", type: "document", media_storage_path: "org/conv/m.pdf", media_mime: "application/pdf" };
const textMsg = { direction: "inbound" as const, body: "oi", sent_at: "t" };

describe("buildNativeMediaParts", () => {
  it("flag off → []", async () => {
    const parts = await buildNativeMediaParts({ messages: [imgMsg], provider: "anthropic", model: "claude", multimodalInput: false, admin: signer() as never });
    expect(parts).toEqual([]);
  });
  it("provider capaz + imagem → part file com mediaType da imagem (AI SDK v7)", async () => {
    const parts = await buildNativeMediaParts({ messages: [imgMsg], provider: "anthropic", model: "claude-sonnet-4-6", multimodalInput: true, admin: signer() as never });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "file", mediaType: "image/jpeg" });
  });
  it("pdf em provider com pdf → part file", async () => {
    const parts = await buildNativeMediaParts({ messages: [pdfMsg], provider: "google", model: "gemini-2.5-pro", multimodalInput: true, admin: signer() as never });
    expect(parts[0]).toMatchObject({ type: "file", mediaType: "application/pdf" });
  });
  it("provider incapaz (desconhecido) → [] (derivado cobre)", async () => {
    const parts = await buildNativeMediaParts({ messages: [imgMsg], provider: "nova-ia", model: "x", multimodalInput: true, admin: signer() as never });
    expect(parts).toEqual([]);
  });
  it("texto puro → []", async () => {
    const parts = await buildNativeMediaParts({ messages: [textMsg], provider: "anthropic", model: "claude", multimodalInput: true, admin: signer() as never });
    expect(parts).toEqual([]);
  });
  it("só a mídia inbound MAIS RECENTE entra (evita re-enviar histórico caro)", async () => {
    const older = { ...imgMsg, media_storage_path: "org/conv/old.jpg" };
    const parts = await buildNativeMediaParts({ messages: [older, imgMsg], provider: "anthropic", model: "claude", multimodalInput: true, admin: signer() as never, maxItems: 1 });
    expect(parts).toHaveLength(1);
    // os bytes baixados contêm o path (mock) — confirma que baixou a mídia MAIS RECENTE.
    expect(new TextDecoder().decode((parts[0] as { data: Uint8Array }).data)).toContain("m.jpg");
  });
  it("imagem seguida de texto (turno atual é texto) → [] (não re-cobra visão)", async () => {
    const parts = await buildNativeMediaParts({ messages: [imgMsg, textMsg], provider: "anthropic", model: "claude", multimodalInput: true, admin: signer() as never });
    expect(parts).toEqual([]);
  });
  it("falha de download → [] sem lançar (derivado cobre)", async () => {
    await expect(
      buildNativeMediaParts({ messages: [imgMsg], provider: "anthropic", model: "claude", multimodalInput: true, admin: signer(false) as never }),
    ).resolves.toEqual([]);
  });
});
