import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Canais from "@/lib/channels";

/**
 * #2171, item 2 — `media_derived_status` NUNCA nulo.
 *
 * O drain do turno espera a derivação da mídia até um teto de 8 minutos e
 * depois segue sem o texto. Enquanto a coluna está nula, ele espera; quando a
 * esteira decide (ou é obrigada a decidir) que NADA MAIS vai ser tentado, o
 * estado precisa ser terminal COM MOTIVO — senão "ninguém tentou" e "tentou e
 * não deu" continuam sendo o mesmo nulo, invisível para quem opera.
 *
 * Medido no código (workers/media-persist-worker.ts, antes desta mudança):
 * a falha permanente do download gravava só `metadata.media_status = "failed"`
 * e deixava `media_derived_status` nulo; o emit da derivação que falha e o
 * canal que não sabe baixar mídia de entrada faziam o mesmo.
 */
const { updateEqMock, uploadMock, rpcMock, loggerWarnMock } = vi.hoisted(() => ({
  updateEqMock: vi.fn(),
  uploadMock: vi.fn(),
  rpcMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

const messageRow: Record<string, unknown> = {
  id: "msg1",
  organization_id: "org1",
  conversation_id: "conv1",
  channel_session_id: "s1",
  media_url: "http://localhost:3030/api/files/abc.ogg",
  media_mime: "audio/ogg",
  media_storage_path: null as string | null,
  metadata: { raw_type: "audio" } as Record<string, unknown> | null,
};

const conversationRow = { is_group: false };
let conversationReadError: { message: string } | null = null;
/** `true` = o adapter do canal não sabe baixar mídia de entrada. */
let canalSemMidia = false;

vi.mock("@/lib/logger", () => ({
  logger: { warn: (...a: unknown[]) => loggerWarnMock(...a), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cadeia: any = {
          eq: () => cadeia,
          filter: () => cadeia,
          select: () => cadeia,
          then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: "msg1" }], error: null }).then(ok),
        };
        return cadeia;
      },
    }),
    storage: { from: () => ({ upload: uploadMock }) },
    rpc: rpcMock,
  }),
}));

const sessionRow = {
  provider: "waha",
  waha_session_name: "default",
  meta_phone_number_id: null,
  zernio_account_id: null,
};

vi.mock("@/lib/messaging/media/waha-source", () => ({
  fetchWahaMedia: vi.fn(),
}));

/**
 * Adapter sem `fetchInboundMedia` (canal que não sabe baixar mídia de entrada).
 * O `getAdapter` é o real para todo o resto — só o retorno muda quando a
 * flag liga.
 */
vi.mock("@/lib/channels", async (importOriginal) => {
  const original = await importOriginal<typeof Canais>();
  return {
    ...original,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getAdapter: ((p: any) => (canalSemMidia ? {} : original.getAdapter(p))) as typeof original.getAdapter,
  };
});

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

/** A última gravação que o worker fez em `messages`. */
function ultimaGravacao(): Record<string, unknown> {
  const chamada = updateEqMock.mock.calls.at(-1);
  expect(chamada, "o worker não gravou nada em `messages`").toBeDefined();
  return chamada![0] as Record<string, unknown>;
}

describe("media_derived_status nunca fica nulo quando ninguém mais vai tentar (#2171)", () => {
  beforeEach(() => {
    uploadMock.mockReset().mockResolvedValue({ error: null });
    updateEqMock.mockReset();
    rpcMock.mockReset().mockResolvedValue({ error: null });
    loggerWarnMock.mockReset();
    messageRow.media_storage_path = null;
    messageRow.metadata = { raw_type: "audio" };
    conversationRow.is_group = false;
    conversationReadError = null;
    canalSemMidia = false;
    vi.mocked(fetchWahaMedia).mockReset().mockResolvedValue({
      buffer: Buffer.from([1, 2, 3]),
      mime: "audio/ogg",
    });
  });

  it("download que falha na ÚLTIMA tentativa grava failed COM motivo, não nulo", async () => {
    vi.mocked(fetchWahaMedia).mockRejectedValue(new Error("waha_media_503"));

    const r = await persistMessageMedia(eventRow(4));

    expect(r.status).toBe("error");
    const gravado = ultimaGravacao();
    expect(gravado.media_derived_status, "a linha ficaria nula para sempre").toBe("failed");
    const metadata = gravado.metadata as Record<string, unknown>;
    expect(String(metadata.media_derived_motivo ?? ""), "faltou o motivo do failed").toMatch(/waha_media_503/);
  });

  it("upload que falha na ÚLTIMA tentativa também grava failed com motivo", async () => {
    uploadMock.mockResolvedValue({ error: { message: "bucket unreachable" } });

    await persistMessageMedia(eventRow(4));

    const gravado = ultimaGravacao();
    expect(gravado.media_derived_status).toBe("failed");
    const metadata = gravado.metadata as Record<string, unknown>;
    expect(String(metadata.media_derived_motivo ?? "")).toMatch(/bucket unreachable/);
  });

  it("emit da derivação que falha grava failed com motivo (a derivação nunca vai ser pedida)", async () => {
    rpcMock.mockResolvedValue({ error: { message: "emit recusado" } });

    const r = await persistMessageMedia(eventRow());

    expect(r.status).toBe("ok");
    const gravado = ultimaGravacao();
    expect(gravado.media_derived_status, "o evento nunca saiu: ninguém vai derivar").toBe("failed");
    const metadata = gravado.metadata as Record<string, unknown>;
    expect(String(metadata.media_derived_motivo ?? "")).toMatch(/emit recusado/);
    // E a mídia segue persistida — só a derivação é que não vai acontecer.
    expect(metadata.media_status).toBe("stored");
  });

  it("leitura de is_group que falha grava failed com motivo (a derivação fica de fora)", async () => {
    conversationReadError = { message: "conexão recusada" };

    await persistMessageMedia(eventRow());

    const gravado = ultimaGravacao();
    expect(gravado.media_derived_status).toBe("failed");
    const metadata = gravado.metadata as Record<string, unknown>;
    expect(String(metadata.media_derived_motivo ?? "")).toMatch(/conexão recusada/);
    expect(metadata.media_status).toBe("stored");
  });

  it("canal que não sabe baixar mídia de entrada grava skipped com motivo (nada mais vai ser tentado)", async () => {
    canalSemMidia = true;

    const r = await persistMessageMedia(eventRow());

    expect(r.status).toBe("skipped");
    const gravado = ultimaGravacao();
    expect(gravado.media_derived_status, "sem a marca a linha ficaria nula para sempre").toBe("skipped");
    const metadata = gravado.metadata as Record<string, unknown>;
    expect(String(metadata.media_derived_motivo ?? "")).toMatch(/midia_de_entrada|midia|entrada/);
  });

  it("controle: tentativa que AINDA vai tentar de novo continua nula (nada é decidido cedo demais)", async () => {
    vi.mocked(fetchWahaMedia).mockRejectedValue(new Error("waha_media_503"));

    const r = await persistMessageMedia(eventRow(1));

    expect(r.status).toBe("error");
    expect(updateEqMock, "gravação antes da última tentativa mudaria o sentido do nulo").not.toHaveBeenCalled();
  });
});
