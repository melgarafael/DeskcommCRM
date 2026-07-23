import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadMock = vi.fn();
const updateEqMock = vi.fn();
const rpcMock = vi.fn();
const messageRow = {
  id: "msg1",
  organization_id: "org1",
  conversation_id: "conv1",
  media_url: "http://localhost:3030/api/files/abc.jpg",
  media_mime: "image/jpeg",
  media_storage_path: null as string | null,
  metadata: { raw_type: "image" },
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: messageRow, error: null }) }),
        }),
      }),
      update: (patch: Record<string, unknown>) => {
        updateEqMock(patch);
        return { eq: () => ({ eq: async () => ({ error: null }) }) };
      },
    }),
    storage: { from: () => ({ upload: uploadMock }) },
    rpc: rpcMock,
  }),
}));

vi.mock("@/lib/messaging/media/waha-source", () => ({
  fetchWahaMedia: vi.fn(async () => ({ buffer: Buffer.from([1, 2, 3]), mime: "image/jpeg" })),
}));

import { persistMessageMedia } from "@/workers/media-persist-worker";
import { fetchWahaMedia } from "@/lib/messaging/media/waha-source";

function eventRow(attempts = 0) {
  return {
    id: "ev1",
    organization_id: "org1",
    event_type: "media.persist_requested",
    entity_kind: "message",
    entity_id: "msg1",
    payload: { message_id: "msg1" },
    metadata: {},
    consumed_by: [],
    attempts,
  };
}

describe("persistMessageMedia", () => {
  beforeEach(() => {
    uploadMock.mockReset().mockResolvedValue({ error: null });
    updateEqMock.mockReset();
    rpcMock.mockReset().mockResolvedValue({ error: null });
    messageRow.media_storage_path = null;
    vi.mocked(fetchWahaMedia).mockResolvedValue({
      buffer: Buffer.from([1, 2, 3]),
      mime: "image/jpeg",
    });
  });

  it("baixa, sobe pro bucket e atualiza a mensagem", async () => {
    const result = await persistMessageMedia(eventRow());
    expect(result.status).toBe("ok");
    expect(uploadMock).toHaveBeenCalledWith(
      "org1/conv1/msg1.jpg",
      expect.any(Buffer),
      expect.objectContaining({ contentType: "image/jpeg", upsert: true }),
    );
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({
        media_storage_path: "org1/conv1/msg1.jpg",
        media_size_bytes: 3,
        metadata: expect.objectContaining({ media_status: "stored" }),
      }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      "emit_event",
      expect.objectContaining({ p_event_type: "media.derive_requested", p_entity_id: "msg1" }),
    );
  });

  it("pula mensagem já persistida (idempotência)", async () => {
    messageRow.media_storage_path = "org1/conv1/msg1.jpg";
    const result = await persistMessageMedia(eventRow());
    expect(result.status).toBe("skipped");
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("retorna error em falha de download com poucas tentativas, sem marcar failed", async () => {
    vi.mocked(fetchWahaMedia).mockRejectedValue(new Error("waha_media_503"));
    const result = await persistMessageMedia(eventRow(1));
    expect(result.status).toBe("error");
    expect(updateEqMock).not.toHaveBeenCalled();
  });

  it("marca failed quando o download falha na última tentativa (drain dead-letra em seguida)", async () => {
    vi.mocked(fetchWahaMedia).mockRejectedValue(new Error("waha_media_503"));
    const result = await persistMessageMedia(eventRow(4));
    expect(result.status).toBe("error");
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ media_status: "failed" }) }),
    );
  });

  it("marca failed quando o upload falha na última tentativa", async () => {
    uploadMock.mockResolvedValue({ error: { message: "bucket unreachable" } });
    const result = await persistMessageMedia(eventRow(4));
    expect(result.status).toBe("error");
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ media_status: "failed" }) }),
    );
  });
});
