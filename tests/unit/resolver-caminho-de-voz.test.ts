/**
 * A IDEMPOTÊNCIA DA SÍNTESE — provada sem Postgres de verdade.
 *
 * `LedgerStore` é um dublê em memória que se comporta como `pgSendLedger`
 * frente a `resolverChaveDoLedger` (create → 23505 → find → talvez rotate),
 * porque é exatamente esse comportamento que `resolverCaminhoDeVoz` depende
 * de estar correto.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/voz/sintetizar", () => ({
  sintetizarVoz: vi.fn(async (input: { texto: string }) => ({
    audio: Buffer.from("audio-fake"),
    mimeType: "audio/mpeg",
    caracteres: input.texto.length,
  })),
}));

import { sintetizarVoz } from "@/lib/ai/voz/sintetizar";
import { resolverCaminhoDeVoz, VozLedgerTerminalError } from "@/lib/agent-engine/edge/crm/send-voice";
import type { LedgerStore, Row } from "@/lib/agent-engine/edge/crm/send-ledger";

function storeEmMemoria(linhaInicial?: Partial<Row>): LedgerStore & { linha: () => Row | null } {
  let linha: Row | null = linhaInicial
    ? { id: "ledger-1", status: "requested", crm_message_id: null, media_storage_path: null, ...linhaInicial }
    : null;
  return {
    linha: () => linha,
    async create(i, hash) {
      if (linha) throw { code: "23505" };
      linha = { id: "ledger-1", status: "requested", crm_message_id: null, media_storage_path: null };
      void i;
      void hash;
      return linha.id;
    },
    async find() {
      return linha;
    },
    async rotate(_i, _hash) {
      linha = { id: "ledger-2", status: "requested", crm_message_id: null, media_storage_path: null };
      return linha.id;
    },
    async message() {
      return null;
    },
    async update() {},
    async setMediaPath(_org, _key, path) {
      if (!linha) throw new Error("linha inexistente");
      linha = { ...linha, media_storage_path: linha.media_storage_path ?? path };
      return linha.media_storage_path!;
    },
  };
}

const identidade = { tenantId: "org1", leadId: "contact1", jobId: "job1", seq: 1 };
const upload = vi.fn(async (_audio: Buffer, _mime: string) => "org1/conv1/voz-agente-job1-1.mp3");

describe("resolverCaminhoDeVoz", () => {
  it("primeira vez: sintetiza, sobe e grava o path", async () => {
    upload.mockClear();
    vi.mocked(sintetizarVoz).mockClear();
    const store = storeEmMemoria();
    const r = await resolverCaminhoDeVoz({
      store,
      identidade,
      textoFalado: "boa tarde, tudo certo com o pedido",
      voz: { apiKey: "sk", voiceId: "v1" },
      upload,
    });
    expect(r.sintetizouAgora).toBe(true);
    expect(r.mediaStoragePath).toBe("org1/conv1/voz-agente-job1-1.mp3");
    expect(sintetizarVoz).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(store.linha()?.media_storage_path).toBe("org1/conv1/voz-agente-job1-1.mp3");
  });

  it("retry com a MESMA linha requested e path já gravado: reusa, não sintetiza de novo", async () => {
    upload.mockClear();
    vi.mocked(sintetizarVoz).mockClear();
    const store = storeEmMemoria({ status: "requested", media_storage_path: "ja-existe.mp3" });
    const r = await resolverCaminhoDeVoz({
      store,
      identidade,
      textoFalado: "boa tarde, tudo certo com o pedido",
      voz: { apiKey: "sk", voiceId: "v1" },
      upload,
    });
    expect(r.sintetizouAgora).toBe(false);
    expect(r.mediaStoragePath).toBe("ja-existe.mp3");
    expect(sintetizarVoz).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("retry com a linha requested mas SEM path (crash entre sintetizar e gravar): sintetiza agora", async () => {
    upload.mockClear();
    vi.mocked(sintetizarVoz).mockClear();
    const store = storeEmMemoria({ status: "requested", media_storage_path: null });
    const r = await resolverCaminhoDeVoz({
      store,
      identidade,
      textoFalado: "boa tarde",
      voz: { apiKey: "sk", voiceId: "v1" },
      upload,
    });
    expect(r.sintetizouAgora).toBe(true);
    expect(sintetizarVoz).toHaveBeenCalledTimes(1);
  });

  it("linha FAILED (tentativa lógica anterior falhou): rotaciona e sintetiza de novo, nunca reusa o path antigo", async () => {
    upload.mockClear();
    vi.mocked(sintetizarVoz).mockClear();
    const store = storeEmMemoria({ status: "failed", media_storage_path: "audio-da-tentativa-anterior.mp3" });
    const r = await resolverCaminhoDeVoz({
      store,
      identidade,
      textoFalado: "texto revisado desta vez",
      voz: { apiKey: "sk", voiceId: "v1" },
      upload,
    });
    expect(r.sintetizouAgora).toBe(true);
    expect(r.mediaStoragePath).not.toBe("audio-da-tentativa-anterior.mp3");
    expect(store.linha()?.id).toBe("ledger-2"); // rotacionou — identidade nova
  });

  it("linha ACCEPTED (já enviada): recusa sintetizar — VozLedgerTerminalError", async () => {
    const store = storeEmMemoria({ status: "accepted", crm_message_id: "msg1" });
    await expect(
      resolverCaminhoDeVoz({
        store,
        identidade,
        textoFalado: "x",
        voz: { apiKey: "sk", voiceId: "v1" },
        upload,
      }),
    ).rejects.toThrow(VozLedgerTerminalError);
  });

  it("linha VETOED (opt-out): recusa sintetizar", async () => {
    const store = storeEmMemoria({ status: "vetoed" });
    await expect(
      resolverCaminhoDeVoz({
        store,
        identidade,
        textoFalado: "x",
        voz: { apiKey: "sk", voiceId: "v1" },
        upload,
      }),
    ).rejects.toThrow(VozLedgerTerminalError);
  });
});
