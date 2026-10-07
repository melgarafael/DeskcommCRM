import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LGPD: o media-persist-worker não regrava `messages` numa mensagem que a
 * anonimização redigiu entre a leitura e a escrita — a mesma guarda do
 * media-derive-worker (#1991).
 *
 * A corrida: o worker lê a mensagem (mídia presente, metadata da ingestão) →
 * o contato é anonimizado (body vira o sentinela, metadata `{}`, mídia zerada)
 * → o worker grava `metadata` (a foto antiga) e o caminho do objeto que acabou
 * de subir. Sem a guarda a cascata é desfeita em silêncio.
 *
 * O dublê avalia os filtros do UPDATE contra a linha COMO ESTÁ AGORA, com a
 * semântica de NULL do Postgres (`NULL <> 'x'` não casa; `IS DISTINCT FROM`
 * casa). Um dublê que decidisse "redigida → zero linhas" sozinho passaria com
 * qualquer filtro, inclusive sem guarda nenhuma.
 */
const BODY_ANONIMIZADO = "[mensagem anonimizada]";

const lida = {
  id: "msg1",
  organization_id: "org1",
  conversation_id: "conv1",
  channel_session_id: "sess1",
  media_url: "http://localhost:3030/api/files/abc.jpg",
  media_mime: "image/jpeg",
  media_storage_path: null as string | null,
  metadata: { raw_type: "image", push_name: "Maria Silva" } as Record<string, unknown>,
  /** Mídia sem legenda: body NULL. */
  body: null as string | null,
};

/** A linha no "banco" agora; a anonimização a reescreve no meio do fluxo. */
let linhaAgora: Record<string, unknown>;
/** Os UPDATEs que de fato casaram a linha. */
let gravacoes: Record<string, unknown>[];
let anonimizarDuranteODownload: boolean;
let downloadFalha: boolean;
/** Sem sessão o worker cai no ramo de canal sem mídia de entrada; a anonimização vem na leitura dela. */
let semSessaoEAnonimizaNaLeitura: boolean;

const uploadMock = vi.fn();
const removeMock = vi.fn();
const rpcMock = vi.fn();

function anonimizar() {
  Object.assign(linhaAgora, {
    body: BODY_ANONIMIZADO,
    media_url: null,
    media_mime: null,
    media_storage_path: null,
    metadata: {},
  });
}

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      select: () => {
        if (tabela === "channel_sessions" && semSessaoEAnonimizaNaLeitura) {
          anonimizar();
          const vazio = { maybeSingle: async () => ({ data: null, error: null }) };
          return { eq: () => ({ ...vazio, eq: () => vazio }) };
        }
        const linha =
          tabela === "channel_sessions"
            ? { provider: "waha", waha_session_name: "default", meta_phone_number_id: null, zernio_account_id: null }
            : tabela === "conversations"
              ? { is_group: false }
              : { ...lida };
        const fim = { maybeSingle: async () => ({ data: linha, error: null }) };
        return { eq: () => ({ ...fim, eq: () => fim }) };
      },
      update: (patch: Record<string, unknown>) => {
        const filtros: [string, string, unknown][] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cadeia: any = {
          eq: (c: string, v: unknown) => (filtros.push(["eq", c, v]), cadeia),
          neq: (c: string, v: unknown) => (filtros.push(["neq", c, v]), cadeia),
          filter: (c: string, op: string, v: unknown) => (filtros.push([op, c, v]), cadeia),
          select: () => cadeia,
          then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) => {
            const casa = filtros.every(([op, c, v]) => {
              const atual = linhaAgora[c] ?? null;
              if (op === "eq") return atual !== null && atual === v;
              if (op === "neq") return atual !== null && atual !== v;
              if (op === "isdistinct") return atual !== v;
              throw new Error(`filtro não emulado: ${op}`);
            });
            if (casa) {
              gravacoes.push(patch);
              Object.assign(linhaAgora, patch);
            }
            return Promise.resolve({ data: casa ? [{ id: "msg1" }] : [], error: null }).then(ok, falha);
          },
        };
        return cadeia;
      },
    }),
    storage: { from: () => ({ upload: uploadMock, remove: removeMock }) },
    rpc: rpcMock,
  }),
}));

vi.mock("@/lib/messaging/media/waha-source", () => ({
  fetchWahaMedia: vi.fn(async () => {
    if (anonimizarDuranteODownload) anonimizar();
    if (downloadFalha) throw new Error("waha_media_503");
    return { buffer: Buffer.from([1, 2, 3]), mime: "image/jpeg" };
  }),
}));

import { persistMessageMedia } from "@/workers/media-persist-worker";

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

describe("persistMessageMedia — LGPD: não regrava mensagem anonimizada no meio do caminho", () => {
  beforeEach(() => {
    linhaAgora = { ...lida, metadata: { ...lida.metadata } };
    gravacoes = [];
    anonimizarDuranteODownload = false;
    downloadFalha = false;
    semSessaoEAnonimizaNaLeitura = false;
    uploadMock.mockReset().mockResolvedValue({ error: null });
    removeMock.mockReset().mockResolvedValue({ error: null });
    rpcMock.mockReset().mockResolvedValue({ error: null });
  });

  it("mensagem viva (body NULL) é gravada e a derivação é pedida — controle", async () => {
    const r = await persistMessageMedia(eventRow());
    expect(r.status, `detail=${r.detail}`).toBe("ok");
    expect(gravacoes).toHaveLength(1);
    expect(linhaAgora.media_storage_path).toBe("org1/conv1/msg1.jpg");
    expect(removeMock).not.toHaveBeenCalled();
    expect(rpcMock).toHaveBeenCalledWith(
      "emit_event",
      expect.objectContaining({ p_event_type: "media.derive_requested" }),
    );
  });

  it("lê → anonimiza → grava: nenhuma gravação, o objeto recém-subido sai do bucket, sem derivação", async () => {
    anonimizarDuranteODownload = true;

    const r = await persistMessageMedia(eventRow());

    expect(gravacoes).toEqual([]);
    expect(linhaAgora.metadata).toEqual({});
    expect(linhaAgora.media_storage_path).toBeNull();
    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("message_redacted");
    expect(removeMock).toHaveBeenCalledWith(["org1/conv1/msg1.jpg"]);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("lê → anonimiza → falha na última tentativa: o `failed` também não regrava a metadata", async () => {
    anonimizarDuranteODownload = true;
    downloadFalha = true;

    const r = await persistMessageMedia(eventRow(4));

    expect(r.status).toBe("error");
    expect(gravacoes).toEqual([]);
    expect(linhaAgora.metadata).toEqual({});
  });

  it("falha na última tentativa com a mensagem viva marca `failed` — controle", async () => {
    downloadFalha = true;
    const r = await persistMessageMedia(eventRow(4));
    expect(r.status).toBe("error");
    expect(gravacoes).toHaveLength(1);
    expect(linhaAgora.metadata).toMatchObject({ media_status: "failed" });
  });

  it("canal sem mídia de entrada, anonimizado no meio: o `skipped` não regrava a metadata", async () => {
    semSessaoEAnonimizaNaLeitura = true;

    const r = await persistMessageMedia(eventRow());

    expect(r.detail).toBe("canal_sem_midia_de_entrada");
    expect(gravacoes).toEqual([]);
    expect(linhaAgora.metadata).toEqual({});
  });
});
