import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LGPD (#1991): o media-derive-worker NUNCA pode gravar uma transcrição
 * (`messages.media_derived_text`) numa mensagem que já foi redigida pela
 * anonimização. A virada de `is_anonymized` dispara um gatilho que já rodou e
 * não alcança esta gravação; a varredura diária (passo 9 de `lib/lgpd`) só
 * conserta em D+1. A correta é fechar NA ORIGEM: uma guarda no UPDATE final.
 *
 * O cenário da issue é a CORRIDA: o worker lê a mensagem (mídia presente) →
 * o contato é anonimizado (body vira `'[mensagem anonimizada]'`, mídia zerada)
 * → o worker tenta gravar. Sem a guarda ele regravaria o texto derivado numa
 * mensagem redigida; com ela, zero linhas são casadas e nada é gravado.
 *
 * O dublê emula o PostgREST do jeito que importa: o UPDATE AVALIA os filtros
 * que o worker mandou contra o `body` atual da linha, com a semântica de NULL
 * do Postgres (`NULL <> 'x'` é NULL e não casa; `IS DISTINCT FROM` casa). Um
 * dublê que decidisse "redigida → zero linhas" sozinho passaria com qualquer
 * filtro — inclusive sem guarda nenhuma, e inclusive com um `neq` que recusa
 * toda nota de voz sem legenda (body NULL).
 */
const downloadMock = vi.fn();
const updateEqMock = vi.fn();

/** A linha que a mensagem tinha ANTES da anonimização (mídia presente). */
const messageRow = {
  id: "msg1",
  organization_id: "org1",
  type: "audio" as string,
  media_mime: "audio/ogg",
  media_storage_path: "org1/conv1/msg1.ogg" as string | null,
  media_derived_status: null as string | null,
  /** Nota de voz não tem legenda: a ingestão grava body NULL (`bodyOf`, lib/waha/ingest.ts). */
  body: null as string | null,
};

let bindingDeVisao: { provider: string; model_id: string; credential_id: string | null } | null = null;
let agenteComVideo: Record<string, unknown> | null = { id: "v1" };

/**
 * Verdade do "banco": a mensagem está redigida agora? O teste vira isto no
 * MEIO do fluxo (no dublê de `deriveMediaText`), reproduzindo a corrida
 * "leu — anonimizou — grava".
 */
let redigida: boolean;

/** Os filtros (coluna, valor) que o worker pôs no UPDATE final. */
let filtrosDoUpdate: [string, string, string][];

/** Emula o corpo sentinela que a anonimização grava na mensagem. */
const BODY_ANONIMIZADO = "[mensagem anonimizada]";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const linha =
        tabela === "ai_purpose_bindings"
          ? bindingDeVisao
          : tabela === "ai_agent_versions"
            ? agenteComVideo
            : messageRow;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const terminais: any = {
        maybeSingle: async () => ({ data: linha, error: null }),
        single: async () => ({ data: linha, error: null }),
        update: (patch: Record<string, unknown>) => {
          updateEqMock(patch);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const chain: any = new Proxy(
            {
              eq: (c: string, v: string) => {
                filtrosDoUpdate.push(["eq", c, v]);
                return chain;
              },
              neq: (c: string, v: string) => {
                filtrosDoUpdate.push(["neq", c, v]);
                return chain;
              },
              filter: (c: string, op: string, v: string) => {
                filtrosDoUpdate.push([op, c, v]);
                return chain;
              },
              select: () => {
                filtrosDoUpdate.push(["select", "*", ""]);
                return chain;
              },
              then: (onFulfilled: (v: unknown) => void, onRejected?: (e: unknown) => void) => {
                // O "banco": a linha como está AGORA, e os filtros do worker
                // avaliados contra ela com a semântica de NULL do Postgres.
                const agora: Record<string, unknown> = {
                  ...messageRow,
                  body: redigida ? BODY_ANONIMIZADO : messageRow.body,
                };
                const casa = filtrosDoUpdate.every(([op, c, v]) => {
                  const atual = agora[c];
                  if (op === "eq") return atual !== null && atual === v;
                  if (op === "neq") return atual !== null && atual !== v;
                  if (op === "isdistinct") return atual !== v;
                  return true;
                });
                const p = Promise.resolve({ data: casa ? [messageRow] : [], error: null });
                return p.then(onFulfilled, onRejected);
              },
            },
            { get: (alvo, prop) => (prop in alvo ? alvo[prop as keyof typeof alvo] : () => chain) },
          );
          return chain;
        },
      };
      // A leitura (select) devolve a linha ANTES da virada — é o estado que o
      // worker efetivamente leu no começo do fluxo.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = new Proxy(terminais, {
        get: (alvo, prop) => (prop in alvo ? alvo[prop as keyof typeof alvo] : () => chain),
      });
      return chain;
    },
    storage: { from: () => ({ download: downloadMock }) },
  }),
}));

vi.mock("@/lib/messaging/media/derive", () => ({
  deriveMediaText: vi.fn(),
}));

vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({
  resolveOrgLlmConfig: vi.fn(async () => ({
    provider: "openai",
    apiKey: "sk-test",
    origemDaChave: "credencial_da_organizacao",
    defaultModel: "gpt-5",
    params: {},
    enabledModels: [],
    orcamento: { modo: "off" as const, tetoCents: 0, efetivoEm: null, limiarPct: 80 },
    orcamentoIndisponivelPorque: null,
    baseUrl: null,
  })),
}));

import { deriveMessageMedia } from "@/workers/media-derive-worker";
import { deriveMediaText } from "@/lib/messaging/media/derive";

function eventRow(attempts = 0) {
  return {
    id: "ev1",
    organization_id: "org1",
    event_type: "media.derive_requested",
    entity_kind: "message",
    entity_id: "msg1",
    payload: { message_id: "msg1" },
    metadata: {},
    consumed_by: [],
    attempts,
  };
}

/**
 * O dublê de `deriveMediaText` — o ponto em que a anonimização acontece.
 *
 * `viraRedigida=true` reproduz a corrida da issue: o worker já leu a mensagem
 * (mídia presente) e a virada de `is_anonymized` aconteceu ANTES da gravação
 * final. O texto derivado NÃO pode ser gravado aí.
 */
function derivarComViraRedigida() {
  vi.mocked(deriveMediaText).mockImplementation(async () => {
    redigida = true;
    return "transcrição do áudio real";
  });
}

describe("deriveMessageMedia — LGPD: não grava transcrição em mensagem já redigida (#1991)", () => {
  beforeEach(() => {
    redigida = false;
    filtrosDoUpdate = [];
    downloadMock.mockReset().mockResolvedValue({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null });
    updateEqMock.mockReset();
    messageRow.media_derived_status = null;
    messageRow.type = "audio";
    messageRow.media_storage_path = "org1/conv1/msg1.ogg";
    messageRow.media_mime = "audio/ogg";
    messageRow.body = null;
    bindingDeVisao = null;
    agenteComVideo = { id: "v1" };
    vi.mocked(deriveMediaText).mockReset().mockResolvedValue("transcrição do áudio real");
  });

  it("nota de voz sem legenda (body NULL) é transcrita — a guarda não pode recusá-la", async () => {
    // `NULL <> '[mensagem anonimizada]'` é NULL no Postgres: um `neq` aqui
    // recusaria TODA nota de voz, e o worker devolveria "message_redacted"
    // para mensagens que ninguém anonimizou.
    messageRow.body = null;
    const r = await deriveMessageMedia(eventRow());
    expect(r.status, `detail=${r.detail}`).toBe("ok");
  });

  it("imagem com legenda é transcrita", async () => {
    messageRow.type = "image";
    messageRow.media_mime = "image/jpeg";
    messageRow.body = "olha isso";
    const r = await deriveMessageMedia(eventRow());
    expect(r.status, `detail=${r.detail}`).toBe("ok");
  });

  it("lê → anonimiza → grava: a transcrição NÃO é gravada (nenhum UPDATE efetivo)", async () => {
    // A corrida exata da issue: o worker lê a mensagem com mídia, o contato é
    // anonimizado entre a leitura e a gravação, e o UPDATE final então casa
    // zero linhas. O worker precisa deixar de afirmar sucesso.
    derivarComViraRedigida();

    const r = await deriveMessageMedia(eventRow());

    // A gravação não aconteceu: nada de "ok" sobre uma escrita recusada.
    expect(r.status).not.toBe("ok");
    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("message_redacted");
  });

  it("mensagem viva (não redigida) grava normal — controle do caminho feliz", async () => {
    const r = await deriveMessageMedia(eventRow());
    expect(r.status).toBe("ok");
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ media_derived_text: "transcrição do áudio real", media_derived_status: "ready" }),
    );
  });
});