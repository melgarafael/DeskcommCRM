import { describe, expect, it } from "vitest";

import {
  ehRevogacaoDefinitiva,
  extrairIdDaConta,
  trocarDeviceCodePorTokens,
} from "@/lib/ai/codex/oauth";

function respostaJson(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status });
}

describe("quarentena Codex", () => {
  it("invalid_grant é definitivo (não re-tenta em loop)", () => {
    expect(ehRevogacaoDefinitiva(400, "invalid_grant")).toBe(true);
    expect(ehRevogacaoDefinitiva(401, "unauthorized")).toBe(true);
    expect(ehRevogacaoDefinitiva(429, "rate_limited")).toBe(false);
    expect(ehRevogacaoDefinitiva(500, "internal")).toBe(false);
  });
});

describe("poll do device-code", () => {
  it("authorization_pending volta como pendente (não é erro)", async () => {
    const fetchImpl = (async () =>
      respostaJson(400, { error: "authorization_pending" })) as typeof fetch;
    await expect(
      trocarDeviceCodePorTokens("device-123", fetchImpl, "client-de-teste"),
    ).resolves.toEqual({
      pendente: true,
    });
  });

  it("aprovação devolve os dois tokens", async () => {
    const fetchImpl = (async () =>
      respostaJson(200, {
        refresh_token: "rt",
        access_token: "at",
        expires_in: 3600,
      })) as typeof fetch;
    await expect(
      trocarDeviceCodePorTokens("device-123", fetchImpl, "client-de-teste"),
    ).resolves.toEqual({
      pendente: false,
      refreshToken: "rt",
      accessToken: "at",
      idToken: null,
      expiresIn: 3600,
    });
  });

  it("troca em form-urlencoded com scope (forma observada, não JSON)", async () => {
    let corpo: string | undefined;
    let contentType: string | null | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      corpo = init?.body as string;
      contentType = new Headers(init?.headers).get("content-type");
      return respostaJson(200, { refresh_token: "rt", access_token: "at", expires_in: 1 });
    }) as typeof fetch;
    await trocarDeviceCodePorTokens("device-123", fetchImpl, "client-de-teste");
    expect(contentType).toContain("application/x-www-form-urlencoded");
    const params = new URLSearchParams(corpo);
    expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(params.get("client_id")).toBe("client-de-teste");
  });
});

describe("extrairIdDaConta", () => {
  const jwt = (payload: unknown) =>
    `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

  it("lê o claim aninhado do Codex", () => {
    expect(
      extrairIdDaConta(jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } })),
    ).toBe("acc-1");
  });

  it("cai no topo e depois em organizations[0]", () => {
    expect(extrairIdDaConta(jwt({ chatgpt_account_id: "acc-top" }))).toBe("acc-top");
    expect(extrairIdDaConta(jwt({ organizations: [{ id: "org-9" }] }))).toBe("org-9");
  });

  it("nulo/lixo → null (nunca lança)", () => {
    expect(extrairIdDaConta(null)).toBeNull();
    expect(extrairIdDaConta("nao-e-jwt")).toBeNull();
    expect(extrairIdDaConta(jwt({ nada: 1 }))).toBeNull();
  });
});
