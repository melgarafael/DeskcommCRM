import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  urlDoRegistroDeWebhook,
  validarCredencialChatDeVendedor,
} from "@/lib/channels/chat-de-vendedor/validate-credentials";

/**
 * O aperto de mão do canal OLX (issue #2927): registrar o webhook É a
 * validação da credencial.
 *
 * Duas provas que a doc pública permite sem inventar endpoint: o POST sai
 * exatamente onde a issue diz (`POST {api}/autoservice/v1/chat` com
 * `{"webhook": "<url>"}`), e o que decide se o token serve é a RESPOSTA —
 * 401/403 recusa, 2xx aprova, rede caída é "tente de novo" e não "token
 * inválido".
 */

const fetchFalso = vi.fn();
beforeEach(() => {
  fetchFalso.mockReset();
  vi.stubGlobal("fetch", fetchFalso);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const WEBHOOK = "https://crm.test/api/v1/webhooks/channel/abc";

describe("a validação", () => {
  it("fala com o serviço de chat documentado, com o token e a URL do webhook novo", async () => {
    fetchFalso.mockResolvedValue({ ok: true, status: 200 });

    const r = await validarCredencialChatDeVendedor({ token: "tok" + "x".repeat(20), webhookUrl: WEBHOOK });

    expect(r).toEqual({ ok: true, webhookRegistrado: true });
    expect(fetchFalso).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFalso.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://apps.olx.com.br/autoservice/v1/chat");
    expect(init.method).toBe("POST");
    const cabecalho = "Bearer" + " tok" + "x".repeat(20);
    expect(init.headers).toMatchObject({ Authorization: cabecalho });
    expect(JSON.parse(String(init.body))).toEqual({ webhook: WEBHOOK });
  });

  it("aponta para homologação quando a base pública é trocada", async () => {
    expect(urlDoRegistroDeWebhook("https://homolog.test")).toBe(
      "https://homolog.test/autoservice/v1/chat",
    );
  });

  it("401/403 é token que não serve, e nada é gravado (o chamador decide)", async () => {
    fetchFalso.mockResolvedValue({ ok: false, status: 401 });
    const r = await validarCredencialChatDeVendedor({ token: "x".repeat(30), webhookUrl: WEBHOOK });
    expect(r).toEqual({ ok: false, motivo: "Token recusado pela OLX." });
  });

  it("erro do provedor leva o status na resposta, nunca um ok", async () => {
    fetchFalso.mockResolvedValue({ ok: false, status: 500 });
    const r = await validarCredencialChatDeVendedor({ token: "x".repeat(30), webhookUrl: WEBHOOK });
    expect(r).toEqual({ ok: false, motivo: "A OLX respondeu 500." });
  });

  it("rede caída não é acusação contra o token", async () => {
    fetchFalso.mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await validarCredencialChatDeVendedor({ token: "x".repeat(30), webhookUrl: WEBHOOK });
    expect(r).toEqual({ ok: false, motivo: "Não foi possível falar com a OLX. Tente de novo." });
  });

  it("URL fora de HTTPS recusa ANTES de falar com a rede", async () => {
    const r = await validarCredencialChatDeVendedor({ token: "x".repeat(30), webhookUrl: "http://crm.test/hook" });
    expect(r).toMatchObject({ ok: false });
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});
