import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/channels/olx/ingest", () => ({
  ingestOlxInbound: vi.fn(async () => ({ status: "ingested" })),
}));

import { CHANNEL_PROVIDER_OLX } from "@/lib/channels/capabilities";
import { canalChatDeVendedorLigado } from "@/lib/channels/chat-de-vendedor/credentials";
import {
  acceptsInboundWebhook,
  handleInboundWebhook,
  verifyInboundWebhookSignature,
} from "@/lib/channels/inbound";
import { ingestOlxInbound } from "@/lib/channels/olx/ingest";

/**
 * O CANAL DO CHAT DE VENDEDOR DA OLX NASCE DESLIGADO (molde do #1459, o que o
 * mantidor cobrou em 22/10 no PR #3257).
 *
 * "Quem não liga não vê nada": nem rota de conexão (404, provado no teste da
 * rota), nem webhook aceitando, nem envio. Aqui fica a regra do interruptor e a
 * ENTRADA, que é onde um canal desligado mais dói se vazar — mensagem forjada
 * chegando na caixa de quem nem usa o canal.
 */
const ORIGINAL = process.env.OLX_ENABLED;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.OLX_ENABLED;
  else process.env.OLX_ENABLED = ORIGINAL;
  vi.clearAllMocks();
});

const PAYLOAD = JSON.stringify({
  chatId: "chat-abc",
  messageId: "msg-1",
  message: "Olá, tenho interesse",
  senderType: "buyer",
  email: "cliente@exemplo.com",
  name: "Fulana",
  phone: "+55 31 99999-8888",
  messageTimestamp: "2026-10-22T12:00:00.000",
  origin: "buyer",
  listId: "listing-9",
});

const sessao = { id: "sess-1", organization_id: "org-1", provider: CHANNEL_PROVIDER_OLX };

describe("o interruptor da instalação", () => {
  it("vazio, ausente ou qualquer coisa que não seja `true` deixa DESLIGADO", () => {
    for (const v of [undefined, "", " ", "false", "1", "sim", "yes", "TRUE_"]) {
      expect(canalChatDeVendedorLigado(v), String(v)).toBe(false);
    }
    expect(canalChatDeVendedorLigado("true")).toBe(true);
    expect(canalChatDeVendedorLigado(" TRUE ")).toBe(true);
  });

  it("o `.env.example` entrega o canal desligado", () => {
    const exemplo = readFileSync(".env.example", "utf8");
    expect(exemplo).toMatch(/^OLX_ENABLED=$/m);
  });
});

describe("a entrada do canal", () => {
  it("desligado: não aceita webhook nem entrega o corpo ao seam", async () => {
    process.env.OLX_ENABLED = "";
    expect(acceptsInboundWebhook(CHANNEL_PROVIDER_OLX)).toBe(false);
    expect(verifyInboundWebhookSignature(CHANNEL_PROVIDER_OLX, PAYLOAD, new Headers(), null)).toBe(false);
    const r = await handleInboundWebhook({} as never, {
      session: sessao,
      rawBody: PAYLOAD,
      headers: new Headers(),
      secret: null,
    });
    expect(r.ok).toBe(false);
    expect(ingestOlxInbound).not.toHaveBeenCalled();
  });

  it("ligado: aceita, lê o contrato e ingere na sessão do TOKEN", async () => {
    process.env.OLX_ENABLED = "true";
    expect(acceptsInboundWebhook(CHANNEL_PROVIDER_OLX)).toBe(true);
    const r = await handleInboundWebhook({} as never, {
      session: sessao,
      rawBody: PAYLOAD,
      headers: new Headers(),
      secret: null,
    });
    expect(r).toMatchObject({ ok: true, body: { status: "ingested" } });
    expect(ingestOlxInbound).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        organizationId: "org-1",
        channelSessionId: "sess-1",
        mensagem: expect.objectContaining({ chatId: "chat-abc", messageId: "msg-1" }),
      }),
    );
  });

  it("ligado: payload fora do contrato recusa nomeando o CAMPO, sem escrever nada", async () => {
    process.env.OLX_ENABLED = "true";
    const quebrado = JSON.stringify({ chatId: "chat-abc", message: "oi", origin: "buyer" });
    const r = await handleInboundWebhook({} as never, {
      session: sessao,
      rawBody: quebrado,
      headers: new Headers(),
      secret: null,
    });
    expect(r).toMatchObject({ ok: false, code: "contrato_violado" });
    expect(ingestOlxInbound).not.toHaveBeenCalled();
  });

  it("ligado: o ECO da própria conta chega ao ingest como eco, não como mensagem nova", async () => {
    process.env.OLX_ENABLED = "true";
    const eco = JSON.stringify({
      chatId: "chat-abc",
      messageId: "msg-2",
      message: "Oi! Já respondi por aqui.",
      origin: "seller",
    });
    const r = await handleInboundWebhook({} as never, {
      session: sessao,
      rawBody: eco,
      headers: new Headers(),
      secret: null,
    });
    expect(r).toMatchObject({ ok: true });
    // O corte do eco é do INGEST (é ele que sabe o que é escrever); aqui prova
    // que o eco chega marcado e que o seam não o transforma em erro.
    expect(ingestOlxInbound).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ mensagem: expect.objectContaining({ origin: "seller" }) }),
    );
  });
});
