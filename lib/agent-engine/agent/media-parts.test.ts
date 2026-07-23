import { describe, expect, it, vi } from "vitest";

import { buildNativeMediaParts } from "./media-parts";
import type { LeadContextMessage } from "@/lib/agent-engine/edge/crm/get-lead-context";

/**
 * Regressão da VISÃO NATIVA (Onda 3 / re-verificado 2026-07-23): prova que a
 * parte nativa É montada no formato que o AI SDK v7 entrega ao modelo
 * (`{type:'file', data:Buffer, mediaType}`) quando as condições valem. A
 * conclusão anterior de que "a parte não chega ao modelo" estava ERRADA —
 * confirmado ao vivo com Anthropic e OpenAI (com tools+multi-step). Este teste
 * trava o wiring pra o mito não voltar.
 */

// admin.storage.from(bucket).download(path) → { data: Blob, error: null }
function fakeAdmin(bytes: Buffer, opts: { fail?: boolean } = {}) {
  return {
    storage: {
      from: () => ({
        download: vi.fn(async () =>
          opts.fail
            ? { data: null, error: new Error("boom") }
            : { data: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, error: null },
        ),
      }),
    },
  } as never;
}

const imageInbound: LeadContextMessage = {
  direction: "inbound",
  body: "[image]",
  sent_at: "2026-07-23T10:00:00Z",
  type: "image",
  media_storage_path: "org/conv/msg.jpg",
  media_mime: "image/jpeg",
};

describe("buildNativeMediaParts — regressão da visão nativa", () => {
  it("imagem inbound + provider capaz + multimodal on → 1 file part com mediaType MIME e bytes Buffer", async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // header JPEG
    const parts = await buildNativeMediaParts({
      messages: [imageInbound],
      provider: "openai",
      model: "gpt-4o",
      multimodalInput: true,
      admin: fakeAdmin(bytes),
    });
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe("file");
    expect(parts[0]!.mediaType).toBe("image/jpeg");
    expect(Buffer.isBuffer(parts[0]!.data)).toBe(true);
    expect(parts[0]!.data.equals(bytes)).toBe(true);
  });

  it("multimodalInput=false → [] (feature desligada no agente)", async () => {
    const parts = await buildNativeMediaParts({
      messages: [imageInbound],
      provider: "openai",
      model: "gpt-4o",
      multimodalInput: false,
      admin: fakeAdmin(Buffer.from([1])),
    });
    expect(parts).toEqual([]);
  });

  it("provider sem capacidade de visão → [] (derivado textual cobre)", async () => {
    const parts = await buildNativeMediaParts({
      messages: [imageInbound],
      provider: "desconhecido",
      model: "modelo-x",
      multimodalInput: true,
      admin: fakeAdmin(Buffer.from([1])),
    });
    expect(parts).toEqual([]);
  });

  it("última inbound sem mídia → [] (não re-anexa mídia antiga do histórico)", async () => {
    const parts = await buildNativeMediaParts({
      messages: [imageInbound, { direction: "inbound", body: "e aí?", sent_at: "2026-07-23T10:05:00Z" }],
      provider: "openai",
      model: "gpt-4o",
      multimodalInput: true,
      admin: fakeAdmin(Buffer.from([1])),
    });
    expect(parts).toEqual([]);
  });

  it("download do storage falha → [] sem lançar (turno nunca aborta pela mídia)", async () => {
    const parts = await buildNativeMediaParts({
      messages: [imageInbound],
      provider: "openai",
      model: "gpt-4o",
      multimodalInput: true,
      admin: fakeAdmin(Buffer.from([1]), { fail: true }),
    });
    expect(parts).toEqual([]);
  });
});
