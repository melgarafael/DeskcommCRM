// @vitest-environment node
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * #3971 — o `ID:` que a tela mostra tem de existir no log.
 *
 * Medido no app real (next build/start, 500 em /api/v1/contacts): a tela mostrava
 * o `X-Request-Id` da resposta, e ele aparecia em ZERO linhas do log; a linha de
 * erro do `fail()` tinha outro id. O `proxy.ts` gravava o próprio id na resposta,
 * e o Next só acrescenta o cabeçalho da rota quando o do middleware NÃO existe
 * (`next/dist/server/send-response.js`). Testar `fail()` sozinho não via isso:
 * aqui o proxy e a rota rodam juntos, e a resposta final é montada pela mesma
 * regra do Next.
 */
vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://supabase.exemplo",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-de-teste",
  },
}));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function passarPeloProxy(caminho: string, cabecalhos?: Record<string, string>) {
  const { proxy } = await import("@/proxy");
  const { NextRequest } = await import("next/server");
  const resposta = await proxy(new NextRequest(`https://crm.exemplo${caminho}`, { headers: cabecalhos }));
  return {
    // o que a rota lê em `req.headers.get("x-request-id")`
    idNaRequisicao: resposta.headers.get("x-middleware-request-x-request-id"),
    idNaResposta: resposta.headers.get("x-request-id"),
  };
}

/** A rota responde 500 por `fail()`; devolve o cabeçalho FINAL e os ids logados. */
async function rotaQueFalha(idDoProxyNaResposta: string | null, idDaRota: string) {
  const { fail } = await import("@/lib/api/wrappers");
  const linhas: string[] = [];
  vi.spyOn(console, "error").mockImplementation((linha: unknown) => {
    linhas.push(String(linha));
  });
  const resposta = fail("internal_error", "falhou", 500, { requestId: idDaRota });
  const idsNoLog = linhas.map((l) => (JSON.parse(l) as { requestId?: string }).requestId);
  // Regra do Next: o cabeçalho do middleware vence; o da rota só entra se faltar.
  const final = idDoProxyNaResposta ?? resposta.headers.get("X-Request-Id");
  return { final, idsNoLog };
}

afterEach(() => vi.restoreAllMocks());

describe("o X-Request-Id que a tela vê é o que está no log (#3971)", () => {
  it("rota que gera o próprio id: a resposta final carrega o id que o fail() logou", async () => {
    const { idNaResposta } = await passarPeloProxy("/api/v1/health", { "x-request-id": randomUUID() });
    const { final, idsNoLog } = await rotaQueFalha(idNaResposta, randomUUID());
    expect(idsNoLog).toHaveLength(1);
    expect(final).toBe(idsNoLog[0]);
  });

  it("rota que lê o id da requisição: recebe o do proxy, e a resposta final é ele", async () => {
    const { idNaRequisicao, idNaResposta } = await passarPeloProxy("/api/v1/health");
    expect(idNaRequisicao).toMatch(UUID);
    const { final, idsNoLog } = await rotaQueFalha(idNaResposta, idNaRequisicao!);
    expect(final).toBe(idNaRequisicao);
    expect(idsNoLog).toEqual([idNaRequisicao]);
  });

  it("fora de /api/ a resposta ainda leva o X-Request-Id, igual ao da requisição", async () => {
    const { idNaRequisicao, idNaResposta } = await passarPeloProxy("/login");
    expect(idNaResposta).toMatch(UUID);
    expect(idNaResposta).toBe(idNaRequisicao);
  });

  it("aceita o UUID que o navegador mandou e troca o que não é UUID", async () => {
    const doNavegador = randomUUID();
    expect((await passarPeloProxy("/login", { "x-request-id": doNavegador })).idNaRequisicao).toBe(doNavegador);
    const forjado = (await passarPeloProxy("/login", { "x-request-id": "nao-e-uuid" })).idNaRequisicao;
    expect(forjado).toMatch(UUID);
  });
});
