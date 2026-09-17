import { describe, expect, it, vi, beforeEach } from "vitest";

import { WacallsClient, wacallsFriendlyError, wacallsSemConexao } from "./client";

/**
 * O corpo EXATO que o WaCalls devolveu na VPS em 2026-09-15 11:10 UTC, 60 s
 * depois de "sessão pareada" — copiado do log do app, não reconstruído.
 */
const SOCKET_CAIDO = new Error(
  'wacalls_500: {"error":"usync devices: failed to send usync query: websocket not connected"}\n',
);

describe("wacallsSemConexao", () => {
  it("reconhece o socket caído pelo texto que vem de dentro do whatsmeow", () => {
    expect(wacallsSemConexao(SOCKET_CAIDO)).toBe(true);
  });

  it("não confunde com as outras recusas do upstream", () => {
    expect(wacallsSemConexao(new Error("wacalls_503: not paired"))).toBe(false);
    expect(wacallsSemConexao(new Error("wacalls_409: operator already on a call"))).toBe(false);
    expect(wacallsSemConexao(new Error("network timeout"))).toBe(false);
  });
});

describe("wacallsFriendlyError", () => {
  it("socket caído diz que é passageiro e o que fazer, em vez do genérico", () => {
    const texto = wacallsFriendlyError(SOCKET_CAIDO);
    expect(texto).not.toBe("Não foi possível completar a chamada. Tente novamente em instantes.");
    expect(texto).toContain("sem conexão com o WhatsApp");
    expect(texto).toContain("Aguarde alguns segundos");
    expect(texto).toContain("Configurações › Canais");
  });

  it("traduz operator already on a call para mensagem amigável", () => {
    expect(wacallsFriendlyError(new Error("operator already on a call"))).toBe(
      "Você já está em outra chamada. Encerre-a antes de iniciar uma nova.",
    );
  });

  it("traduz not paired para orientação de pareamento", () => {
    expect(wacallsFriendlyError(new Error("session not paired"))).toBe(
      "O número de chamada de voz ainda não foi pareado. Configure em Configurações › Canais.",
    );
  });

  it("traduz o texto que o upstream escreve de fato — `no session <id>`", () => {
    expect(wacallsFriendlyError(new Error('wacalls_404: {"error":"no session 2f27b0e0"}'))).toBe(
      "Sessão de chamada de voz não encontrada.",
    );
  });

  it("traduz no such session para sessão não encontrada", () => {
    expect(wacallsFriendlyError(new Error("no such session found"))).toBe(
      "Sessão de chamada de voz não encontrada.",
    );
  });

  it("devolve mensagem genérica para erros desconhecidos", () => {
    expect(wacallsFriendlyError(new Error("network timeout"))).toBe(
      "Não foi possível completar a chamada. Tente novamente em instantes.",
    );
  });
});

describe("WacallsClient", () => {
  const baseUrl = "http://wacalls-test:8080";
  // O upstream autenticado não tem modo aberto: o cliente exige o Bearer no
  // construtor, e sem ele toda chamada volta 401. Ver lib/env.ts.
  const token = "token-de-teste";
  let client: WacallsClient;

  beforeEach(() => {
    client = new WacallsClient(baseUrl, token);
    vi.restoreAllMocks();
  });

  it("createSession envia POST para /api/sessions com JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "sess_123" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await client.createSession("org_test");
    expect(res).toEqual({ id: "sess_123" });
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/api/sessions`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "org_test" }),
      }),
    );
  });

  it("startCall passa X-Client-Id no header e telefone no body sem gravar", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ call: { callId: "call_abc" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await client.startCall("sess_123", "user_xyz", "+5511999998888");
    expect(res).toEqual({ callId: "call_abc" });

    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs).toBeDefined();
    if (!callArgs) throw new Error("fetch not called");

    expect(callArgs[0]).toBe(`${baseUrl}/api/sessions/sess_123/calls`);
    const init = callArgs[1] as RequestInit;
    expect(init.headers).toMatchObject({
      "X-Client-Id": "user_xyz",
      "Content-Type": "application/json",
    });
    const parsedBody = JSON.parse(init.body as string);
    expect(parsedBody).toEqual({ phone: "+5511999998888" });
    expect(parsedBody.record).toBeUndefined();
  });

  it("lança erro estruturado quando a API do WaCalls responde com status de erro", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "operator already on a call",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.startCall("s1", "u1", "+5511999999999")).rejects.toThrow(
      "wacalls_400: operator already on a call",
    );
  });
});
