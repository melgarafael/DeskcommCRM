import { describe, expect, it } from "vitest";

import {
  ehRevogacaoDefinitiva,
  extrairIdDaConta,
  trocarDeviceCodePorTokens,
} from "@/lib/ai/codex/oauth";

function respostaJson(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status });
}

/** Sequência de respostas por chamada (poll → exchange). */
function fetchSequencia(respostas: Response[]): typeof fetch {
  let i = 0;
  return (async () => respostas[Math.min(i++, respostas.length - 1)]) as typeof fetch;
}

describe("quarentena Codex", () => {
  it("invalid_grant é definitivo (não re-tenta em loop)", () => {
    expect(ehRevogacaoDefinitiva(400, "invalid_grant")).toBe(true);
    expect(ehRevogacaoDefinitiva(401, "unauthorized")).toBe(true);
    expect(ehRevogacaoDefinitiva(429, "rate_limited")).toBe(false);
    expect(ehRevogacaoDefinitiva(500, "internal")).toBe(false);
  });
});

describe("poll do device-code (forma observada)", () => {
  it("403/404 volta como pendente (não é erro)", async () => {
    const fetchImpl = fetchSequencia([respostaJson(404, { error: "not_found" })]);
    await expect(
      trocarDeviceCodePorTokens("da-123", "ABCD-1234", fetchImpl, "client-de-teste"),
    ).resolves.toEqual({ pendente: true });
  });

  it("aprovação → troca no token endpoint (FORM) e devolve os tokens", async () => {
    let corpoTroca: string | undefined;
    let contentTroca: string | null | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const url = String(_url);
      if (url.includes("deviceauth/token")) {
        return respostaJson(200, { authorization_code: "auth-code", code_verifier: "verifier" });
      }
      corpoTroca = init?.body as string;
      contentTroca = new Headers(init?.headers).get("content-type");
      return respostaJson(200, {
        refresh_token: "rt",
        access_token: "at",
        id_token: "h.e30.s",
        expires_in: 3600,
      });
    }) as typeof fetch;
    await expect(
      trocarDeviceCodePorTokens("da-123", "ABCD-1234", fetchImpl, "client-de-teste"),
    ).resolves.toEqual({
      pendente: false,
      refreshToken: "rt",
      accessToken: "at",
      idToken: "h.e30.s",
      expiresIn: 3600,
    });
    // A troca é FORM com redirect fixo do device-flow — não JSON.
    expect(contentTroca).toContain("application/x-www-form-urlencoded");
    const params = new URLSearchParams(corpoTroca);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("auth-code");
    expect(params.get("code_verifier")).toBe("verifier");
    expect(params.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
    expect(params.get("client_id")).toBe("client-de-teste");
  });

  it("500 no poll não é pendente — é erro (sessão morta, não operador lento)", async () => {
    const fetchImpl = fetchSequencia([respostaJson(500, { error: "x" })]);
    await expect(
      trocarDeviceCodePorTokens("da-123", "ABCD-1234", fetchImpl, "client-de-teste"),
    ).rejects.toThrow(/codex_device_poll_500/);
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
