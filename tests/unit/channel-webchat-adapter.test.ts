import { afterEach, describe, expect, it, vi } from "vitest";

import { webchatAdapter } from "@/lib/channels/adapters/webchat";
import type { OutboundEnvelope } from "@/lib/channels/types";

/**
 * ADAPTER DO CHAT NO SITE — tradução de formato, sem rede.
 *
 * 1. o `send` de texto NÃO fala com nenhum terceiro: o handler já gravou a
 *    mensagem, e o adapter só devolve o id próprio do canal;
 * 2. o `externalId` segue `wc:out:<uuid>`, e a chave da sessão nunca entra nele;
 * 3. mídia e corpo vazio são recusados nomeando o motivo, como no Telegram.
 */

const CHAVE = "wck_C0nhecidaPeloWidget-abcDEF123_xyz";
const VISITANTE = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

const ENVELOPE: OutboundEnvelope = {
  organizationId: "org-1",
  sessionRef: CHAVE,
  to: "provider-chat",
  kind: "text",
  body: "Olá, posso ajudar?",
  providerConversationId: VISITANTE,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("webchatAdapter.send", () => {
  it("texto devolve o id próprio do canal e não faz nenhuma chamada de rede", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("o chat não deve falar com terceiro");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const r = await webchatAdapter.send(ENVELOPE);

    expect(r.externalId).toMatch(/^wc:out:[0-9a-f-]{36}$/);
    expect(r.externalId).not.toContain(CHAVE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mídia é recusada nomeando o tipo, como o Telegram", async () => {
    await expect(webchatAdapter.send({ ...ENVELOPE, kind: "image" })).rejects.toThrow(
      /webchat_media_not_supported/,
    );
  });

  it("corpo vazio não vira mensagem em branco", async () => {
    await expect(webchatAdapter.send({ ...ENVELOPE, body: "   " })).rejects.toThrow(/webchat_empty_body/);
  });
});

describe("webchatAdapter — destinatário e configuração", () => {
  it("o destinatário é o marcador da thread, como no Telegram", () => {
    expect(webchatAdapter.resolveRecipient({ isGroup: false } as never)).toBe("provider-chat");
  });

  it("isConfigured é sempre true: quem barra é o handler, pelo estado da conexão", () => {
    expect(webchatAdapter.isConfigured()).toBe(true);
  });
});
