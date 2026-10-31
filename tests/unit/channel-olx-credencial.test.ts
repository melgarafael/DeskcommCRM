import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  admin: { state: null as unknown },
  decrypt: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.admin.state }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: h.decrypt }));

import { olxAdapter } from "@/lib/channels/adapters/olx";
import { resolveTokenChatDeVendedor } from "@/lib/channels/chat-de-vendedor/credentials";
import type { OutboundEnvelope } from "@/lib/channels/types";

/**
 * A CREDENCIAL do canal OLX: guardada cifrada em `olx_token_encrypted` e LIDA
 * de verdade no envio (issue #2927, critério E do mantidor — "fim da coluna
 * vazia").
 *
 * Duas metades do mesmo critério: `resolveTokenChatDeVendedor` é o único lugar
 * que lê a coluna, e `send` é o único que a usa. Sem credencial (ou com o
 * canal desligado) o envio desiste nomeando o motivo — nunca um `sent` sem id.
 */

const ORIGINAL = process.env.OLX_ENABLED;
const fetchFalso = vi.fn();

beforeEach(() => {
  h.decrypt.mockReset();
  h.decrypt.mockResolvedValue("token-de-teste");
  fetchFalso.mockReset();
  vi.stubGlobal("fetch", fetchFalso);
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.OLX_ENABLED;
  else process.env.OLX_ENABLED = ORIGINAL;
  vi.unstubAllGlobals();
});

/** Admin falso com a única consulta que a credencial faz. */
function adminComLinha(linha: Record<string, unknown> | null, selects: string[] = []) {
  return {
    from(tabela: string) {
      expect(tabela).toBe("channel_sessions");
      const q: Record<string, unknown> = {};
      q.select = (cols: string) => {
        selects.push(cols);
        return q;
      };
      q.eq = () => q;
      q.is = () => q;
      q.maybeSingle = async () => ({ data: linha, error: null });
      return q;
    },
  };
}

function envelope(over: Partial<OutboundEnvelope> = {}): OutboundEnvelope {
  return {
    organizationId: "org-1",
    sessionRef: "seller-42",
    to: "5531999998888",
    kind: "text",
    body: "olá",
    providerConversationId: "chat-abc",
    ...over,
  };
}

describe("a credencial é lida de `olx_token_encrypted`", () => {
  it("busca pela conta de vendedor DENTRO da organização e decifra o token", async () => {
    const selects: string[] = [];
    h.admin.state = adminComLinha(
      { id: "sess-1", olx_seller_id: "seller-42", olx_token_encrypted: "\\x01ab" },
      selects,
    );

    const creds = await resolveTokenChatDeVendedor(h.admin.state as never, {
      organizationId: "org-1",
      sellerId: "seller-42",
    });

    expect(selects[0]).toContain("olx_token_encrypted");
    expect(creds).toEqual({
      channelSessionId: "sess-1",
      sellerId: "seller-42",
      token: "token-de-teste",
    });
  });

  it("sessão sem token gravado devolve null — e o token cifrado nunca é lido por outro código", async () => {
    h.admin.state = adminComLinha({ id: "sess-1", olx_seller_id: "seller-42", olx_token_encrypted: null });
    const creds = await resolveTokenChatDeVendedor(h.admin.state as never, {
      organizationId: "org-1",
      sellerId: "seller-42",
    });
    expect(creds).toBeNull();
    expect(h.decrypt).not.toHaveBeenCalled();
  });
});

describe("o envio real", () => {
  it("com o canal ligado e credencial gravada, o POST sai com o token da sessão", async () => {
    process.env.OLX_ENABLED = "true";
    h.admin.state = adminComLinha({
      id: "sess-1",
      olx_seller_id: "seller-42",
      olx_token_encrypted: "\\x01ab",
    });
    fetchFalso.mockResolvedValue({ ok: true, status: 200, text: async () => "" });

    const beforeSend = vi.fn(async () => undefined);
    const r = await olxAdapter.send(envelope({ beforeSend }));

    // A resposta de sucesso da OLX é só um status — externalId `null` é o
    // honesto, e o seam o distingue de "não tentei".
    expect(r).toEqual({ externalId: null });
    expect(beforeSend).toHaveBeenCalledTimes(1);

    expect(fetchFalso).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFalso.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://apps.olx.com.br/autoservice/v1/chat/send");
    expect(init.method).toBe("POST");
    const cabecalhoDeAutorizacao = "Bearer" + " token-de-teste";
    expect(init.headers).toMatchObject({ Authorization: cabecalhoDeAutorizacao });
    expect(JSON.parse(String(init.body))).toEqual({ chatId: "chat-abc", textMessage: "olá" });
  });

  it("com o canal ligado e SEM credencial, desiste com `olx_not_configured` sem tentar a rede", async () => {
    process.env.OLX_ENABLED = "true";
    h.admin.state = adminComLinha(null);

    await expect(olxAdapter.send(envelope())).rejects.toThrow(/^olx_not_configured/);
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("com o canal DESLIGADO (padrão), desiste com `olx_not_configured` — regressão zero da fase 1", async () => {
    delete process.env.OLX_ENABLED;
    // Nem vai ao banco: o interruptor vem primeiro.
    h.admin.state = adminComLinha({
      id: "sess-1",
      olx_seller_id: "seller-42",
      olx_token_encrypted: "\\x01ab",
    });

    await expect(olxAdapter.send(envelope())).rejects.toThrow(/^olx_not_configured/);
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("resposta 401 da OLX vira falha com o status no código, nunca um sent", async () => {
    process.env.OLX_ENABLED = "true";
    h.admin.state = adminComLinha({
      id: "sess-1",
      olx_seller_id: "seller-42",
      olx_token_encrypted: "\\x01ab",
    });
    fetchFalso.mockResolvedValue({ ok: false, status: 401, text: async () => "token inválido" });

    await expect(olxAdapter.send(envelope())).rejects.toThrow(/^olx_401: token inválido/);
  });
});

describe("o interruptor responde por `isConfigured`", () => {
  it("desligado (padrão) é false; ligado é true — a outra metade é do send", () => {
    delete process.env.OLX_ENABLED;
    expect(olxAdapter.isConfigured()).toBe(false);
    process.env.OLX_ENABLED = "true";
    expect(olxAdapter.isConfigured()).toBe(true);
  });
});
