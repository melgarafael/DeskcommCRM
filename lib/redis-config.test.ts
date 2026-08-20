import { describe, expect, it } from "vitest";

import { redisConfigError, validarConfigRedisRest } from "./redis-config";

const url = "https://example.upstash.io";
const token = "AXY-test-token";

describe("configuração REST do Redis", () => {
  it("aceita URL e token puros", () => {
    const result = validarConfigRedisRest(url, token);
    expect(result).toEqual({ ok: true, reason: "ok" });
    expect(redisConfigError(result)).toBeUndefined();
  });

  it("classifica ausência de configuração sem construir um cliente", () => {
    const result = validarConfigRedisRest(undefined, undefined);
    expect(result).toEqual({ ok: false, reason: "nao_configurado" });
    expect(redisConfigError(result)).toBe("not_configured");
  });

  it.each([
    ['"https://example.upstash.io"', token],
    [url, '"AXY-test-token"'],
    [url, "\nAXY-test-token"],
    [url, "UPSTASH_REDIS_REST_TOKEN=AXY-test-token"],
    ["not-a-url", token],
  ])("rejeita configuração formatada ou inválida: %s", (badUrl, badToken) => {
    const result = validarConfigRedisRest(badUrl, badToken);
    expect(result).toEqual({ ok: false, reason: "configuracao_invalida" });
    expect(redisConfigError(result)).toBe("invalid_configuration");
  });
});
