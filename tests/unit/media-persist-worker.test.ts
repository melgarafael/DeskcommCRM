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

// Grupo nunca deriva (Task 8, controller A): a IA não serve grupos, e a
// derivação (visão/transcrição paga) não pode ser pedida para eles.
const conversationRow = { is_group: false };
// Fixture de erro (fix round 1, ruling do controller): leitura de
// `conversations.is_group` que falha — o worker precisa fechar FECHADO
// (não deriva) em vez de assumir `is_group: false` por omissão.
let conversationReadError: { message: string } | null = null;
const loggerWarnMock = vi.fn();

vi.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => loggerWarnMock(...args), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    // Três consultas agora, cada uma com um encadeamento diferente: a mensagem
    // casa por `id` + `organization_id` (dois `eq`), a SESSÃO casa só por `id`
    // (um `eq`), a CONVERSA casa por `id` + `organization_id` (dois `eq`,
    // igual à mensagem). O dublê responde pela TABELA porque, sem isso, a
    // consulta da sessão receberia a linha da mensagem — e o worker cairia em
    // "canal sem mídia" achando que a sessão não existe.
    from: (tabela: string) => ({
      select: () => {
        if (tabela === "conversations") {
          return {
            eq: () => ({
              eq: () => ({
                maybeSingle: async () =>
                  conversationReadError
                    ? { data: null, error: conversationReadError }
                    : { data: conversationRow, error: null },
              }),
            }),
          };
        }
        const linha = tabela === "channel_sessions" ? sessionRow : messageRow;
        const resolvido = { maybeSingle: async () => ({ data: linha, error: null }) };
        return { eq: () => ({ ...resolvido, eq: () => resolvido }) };
      },
      update: (patch: Record<string, unknown>) => {
        updateEqMock(patch);
        return { eq: () => ({ eq: async () => ({ error: null }) }) };
      },
    }),
    storage: { from: () => ({ upload: uploadMock }) },
    rpc: rpcMock,
  }),
}));

/**
 * A sessão que o worker resolve para escolher QUEM baixa.
 *
 * `provider: "waha"` mantém este arquivo exercitando o mesmo caminho de sempre —
 * o que muda é que agora ele passa pelo adapter em vez de chamar o transporte
 * fixo. Se o dublê não existisse, o worker sairia em "canal sem mídia" e todos
 * os casos abaixo passariam por AUSÊNCIA.
 */
const sessionRow = {
  provider: "waha",
  waha_session_name: "default",
  meta_phone_number_id: null,
  zernio_account_id: null,
};

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
    conversationRow.is_group = false;
    conversationReadError = null;
    loggerWarnMock.mockReset();
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

  it("1:1 (controle): persiste E pede derivação", async () => {
    conversationRow.is_group = false;
    const result = await persistMessageMedia(eventRow());
    expect(result.status).toBe("ok");
    expect(uploadMock).toHaveBeenCalled();
    expect(rpcMock).toHaveBeenCalledWith(
      "emit_event",
      expect.objectContaining({ p_event_type: "media.derive_requested", p_entity_id: "msg1" }),
    );
  });

  it("grupo: persiste mas NÃO pede derivação (a IA não serve grupos)", async () => {
    conversationRow.is_group = true;
    const result = await persistMessageMedia(eventRow());
    expect(result.status).toBe("ok");
    expect(uploadMock).toHaveBeenCalled();
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ media_status: "stored" }) }),
    );
    expect(rpcMock).not.toHaveBeenCalledWith(
      "emit_event",
      expect.objectContaining({ p_event_type: "media.derive_requested" }),
    );
  });

  it("erro ao ler conversations.is_group: fecha FECHADO — NÃO pede derivação, avisa com organização/conversa/causa", async () => {
    conversationReadError = { message: "conexão recusada" };
    const result = await persistMessageMedia(eventRow());
    expect(result.status).toBe("ok");
    expect(uploadMock).toHaveBeenCalled();
    // A mídia continua persistida mesmo sem saber se a conversa é de grupo.
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ media_status: "stored" }) }),
    );
    expect(rpcMock).not.toHaveBeenCalledWith(
      "emit_event",
      expect.objectContaining({ p_event_type: "media.derive_requested" }),
    );
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("media-persist"),
      expect.objectContaining({
        organization_id: "org1",
        conversation_id: "conv1",
        detail: "conexão recusada",
      }),
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
