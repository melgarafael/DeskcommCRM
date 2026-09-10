import { describe, expect, it } from "vitest";

import {
  ehRevogacaoDefinitiva,
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
      expiresIn: 3600,
    });
  });
});
