import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  esquecerSessaoDoWebhook,
  limparMemoriaDeSessoes,
  sessaoDoWebhook,
  TTL_MS,
  type LinhaDaSessao,
} from "./sessao-do-webhook";

const linha: LinhaDaSessao = {
  id: "s1",
  organization_id: "o1",
  waha_session_name: "org_x",
  webhook_secret_encrypted: "cifrado",
  status: "WORKING",
  is_warmup_complete: true,
  warmup_started_at: null,
};

function dublês(data: LinhaDaSessao | null = linha, segredo: string | null = "segredo") {
  const carregar = vi.fn(async () => ({ data, error: null }));
  const decifrar = vi.fn(async () => segredo);
  return { carregar, decifrar };
}

describe("sessaoDoWebhook", () => {
  beforeEach(() => limparMemoriaDeSessoes());

  it("dentro do prazo, o segundo webhook não vai ao banco", async () => {
    const { carregar, decifrar } = dublês();
    await sessaoDoWebhook("nome:org_x", carregar, decifrar, 1_000);
    const r = await sessaoDoWebhook("nome:org_x", carregar, decifrar, 1_000 + TTL_MS - 1);
    expect(r).toEqual({ ok: true, valor: { session: linha, segredo: "segredo" } });
    expect(carregar).toHaveBeenCalledTimes(1);
    expect(decifrar).toHaveBeenCalledTimes(1);
  });

  it("vencido o prazo, lê do banco de novo", async () => {
    const { carregar, decifrar } = dublês();
    await sessaoDoWebhook("nome:org_x", carregar, decifrar, 1_000);
    await sessaoDoWebhook("nome:org_x", carregar, decifrar, 1_000 + TTL_MS);
    expect(carregar).toHaveBeenCalledTimes(2);
  });

  it("não guarda 'não encontrado' — canal recém-criado não perde eventos", async () => {
    const { carregar, decifrar } = dublês(null);
    expect(await sessaoDoWebhook("token:t", carregar, decifrar)).toEqual({ ok: true, valor: null });
    await sessaoDoWebhook("token:t", carregar, decifrar);
    expect(carregar).toHaveBeenCalledTimes(2);
  });

  it("não guarda erro de consulta", async () => {
    const carregar = vi.fn(async () => ({ data: null, error: { message: "timeout" } }));
    const decifrar = vi.fn(async () => "x");
    expect(await sessaoDoWebhook("nome:org_x", carregar, decifrar)).toEqual({ ok: false, erro: "timeout" });
    await sessaoDoWebhook("nome:org_x", carregar, decifrar);
    expect(carregar).toHaveBeenCalledTimes(2);
    expect(decifrar).not.toHaveBeenCalled();
  });

  it("guarda sessão sem credencial (placeholder '\\x00', decifrar devolve null): 10 eventos = 1 consulta", async () => {
    // O estado de TODA sessão WAHA criada pelo produto — ver a migration 0240.
    const { carregar, decifrar } = dublês(linha, null);
    for (let i = 0; i < 10; i++) {
      const r = await sessaoDoWebhook("nome:org_x", carregar, decifrar, 1_000 + i);
      expect(r).toEqual({ ok: true, valor: { session: linha, segredo: null } });
    }
    expect(carregar).toHaveBeenCalledTimes(1);
    expect(decifrar).toHaveBeenCalledTimes(1);
  });

  it("não guarda quando a decifragem LANÇA (erro do RPC) — a próxima tenta de novo", async () => {
    const carregar = vi.fn(async () => ({ data: linha, error: null }));
    const decifrar = vi.fn(async (): Promise<string | null> => {
      throw new Error("rpc fora");
    });
    expect(await sessaoDoWebhook("nome:org_x", carregar, decifrar)).toEqual({
      ok: true,
      valor: { session: linha, segredo: null },
    });
    await sessaoDoWebhook("nome:org_x", carregar, decifrar);
    expect(carregar).toHaveBeenCalledTimes(2);
    expect(decifrar).toHaveBeenCalledTimes(2);
  });

  it("esquecer força a próxima leitura do banco (segredo trocado)", async () => {
    const { carregar, decifrar } = dublês();
    await sessaoDoWebhook("nome:org_x", carregar, decifrar);
    esquecerSessaoDoWebhook("nome:org_x");
    await sessaoDoWebhook("nome:org_x", carregar, decifrar);
    expect(carregar).toHaveBeenCalledTimes(2);
  });

  it("chaves diferentes não se misturam", async () => {
    const a = dublês();
    const b = dublês({ ...linha, id: "s2", organization_id: "o2" });
    await sessaoDoWebhook("nome:org_x", a.carregar, a.decifrar);
    const r = await sessaoDoWebhook("token:outro", b.carregar, b.decifrar);
    expect(r.ok && r.valor?.session.organization_id).toBe("o2");
  });
});
