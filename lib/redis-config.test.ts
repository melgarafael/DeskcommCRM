import { describe, expect, it } from "vitest";

import { validarConfigRedisRest } from "./redis-config";

/**
 * Os casos inválidos NÃO são inventados: são as três formas que um `.env` de
 * self-host produz sozinho (aspas do arquivo, a linha inteira colada, a quebra
 * do heredoc), mais a que o Zod de `lib/env.ts` deixa passar por não validar
 * URL (`required()` puro, sem `.url()`).
 */
const url = "https://example.upstash.io";
const token = "AXY-test-token";

describe("configuração REST do Redis", () => {
  it("aceita URL e token puros", () => {
    expect(validarConfigRedisRest(url, token)).toEqual({ ok: true, reason: "ok" });
  });

  it("aceita o endereço do contêiner do kit self-host, com porta e sem TLS", () => {
    // CONTROLE POSITIVO. Sem ele, um validador "seguro" que reprovasse tudo
    // deixaria os casos abaixo verdes e derrubaria toda instalação em VPS: o
    // `.env.hostgator.example` aponta para o contêiner `srh` em http.
    expect(validarConfigRedisRest("http://srh:80", token)).toEqual({ ok: true, reason: "ok" });
  });

  it("separa 'não configurado' de 'configurado errado'", () => {
    // Os dois desfechos são diferentes para quem opera: o primeiro é uma
    // integração que ninguém contratou; o segundo é um arquivo para editar.
    expect(validarConfigRedisRest(undefined, undefined)).toEqual({
      ok: false,
      reason: "nao_configurado",
    });
  });

  it.each([
    ["aspas do .env sobrando na URL", '"https://example.upstash.io"', token],
    ["aspas do .env sobrando no token", url, '"AXY-test-token"'],
    ["aspas simples no token", url, "'AXY-test-token'"],
    ["quebra de linha do heredoc no token", url, "\nAXY-test-token"],
    ["espaço nas pontas do token", url, " AXY-test-token "],
    ["a linha inteira do .env colada no token", url, "UPSTASH_REDIS_REST_TOKEN=AXY-test-token"],
    ["a linha inteira do .env colada na URL", "UPSTASH_REDIS_REST_URL=https://x.io", token],
    ["endereço sem esquema", "example.upstash.io", token],
    ["esquema que não é HTTP", "redis://example.upstash.io", token],
    ["texto que não é endereço", "not-a-url", token],
  ])("rejeita: %s", (_nome, badUrl, badToken) => {
    expect(validarConfigRedisRest(badUrl, badToken)).toEqual({
      ok: false,
      reason: "configuracao_invalida",
    });
  });
});
