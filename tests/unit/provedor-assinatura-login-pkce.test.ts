/**
 * O LOGIN DO CODEX POR PKCE — o que este teste guarda.
 *
 *  1. O VETOR DO RFC 7636 (Apêndice B): se `codeChallengeS256` divergir um
 *     byte, o authorize devolve `invalid_request` e ninguém descobre daqui —
 *     descobre só na hora em que alguém tenta conectar.
 *  2. A URL de authorize com TODOS os parâmetros, inclusive os que não somos
 *     donos: `redirect_uri` é o `localhost:1455` da lista branca do Codex e
 *     `scope` precisa trazer `offline_access`, sem o qual não há refresh_token.
 *  3. A troca do `code` com `fetch` FALSO, devolvendo os dois tokens — prova de
 *     que o corpo do POST é o esperado sem nenhum pedido real a
 *     `auth.openai.com` (não há credencial nesta VPS, e esta frase é o escopo
 *     declarado no PR).
 *  4. A renovação proativa ANTES do prazo e o retry ÚNICO em 401.
 *
 * Sabotagem que confirma que a guarda vigia: trocar `S256` por `plain` no
 * `code_challenge_method` deixa o caso da URL vermelho; atrasar a janela de 8
 * dias para 0 deixa o caso da renovação proativa vermelho.
 */
import { describe, expect, it, vi } from "vitest";

import {
  CLIENT_ID_DO_CODEX,
  ENDPOINT_DE_TOKEN,
  ESCOPO_DO_CODEX,
  REDIRECT_URI_DO_CODEX,
  codeChallengeS256,
  criarSessaoPkce,
  gerarCodeVerifier,
  gerarEstado,
  montarUrlDeAutorizacao,
  renovarPorRefreshToken,
  trocarCodigoPorTokens,
} from "@/lib/ai/pontos/pkce-da-assinatura";
import {
  JANELA_DE_RENOVACAO_MS,
  chamarComRetryUnicoEm401,
  renovacaoProxima,
  renovarSeProxima,
} from "@/lib/ai/pontos/renovacao-da-assinatura";

/** `Response` mínimo: o módulo só lê `ok`, `status` e `json()`. */
function resposta(status: number, corpo: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => corpo,
  } as unknown as Response;
}

describe("o vetor do RFC 7636", () => {
  it("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk dá E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", () => {
    // RFC 7636, Apêndice B — o valor publicado é `...stw-cM` (rfc-editor.org,
    // linha "code_challenge = E9Melhoa…stw-cM"). O octet sequence do próprio
    // RFC (19, 211, 30, 150, …) também codifica para `-cM`; `-xM` circulando por
    // aí é transcrição errada, e usar a cópia errada aqui passaria a conferir um
    // vetor que nenhum servidor do mundo calcula.
    expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("verifier e state saem aleatórios, e o verifier tem o formato do RFC (43–128, base64url)", () => {
    const a = criarSessaoPkce();
    const b = criarSessaoPkce();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.estado).not.toBe(b.estado);
    for (const sessao of [a, b]) {
      expect(sessao.codeVerifier.length).toBeGreaterThanOrEqual(43);
      expect(sessao.codeVerifier.length).toBeLessThanOrEqual(128);
      expect(sessao.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(sessao.estado).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(gerarCodeVerifier()).not.toBe(gerarCodeVerifier());
    expect(gerarEstado()).not.toBe(gerarEstado());
  });
});

describe("a URL de authorize", () => {
  it("traz todos os parâmetros do PKCE, com o redirect_uri e o scope do Codex", () => {
    const sessao = criarSessaoPkce();
    const url = new URL(sessao.url);

    expect(`${url.origin}${url.pathname}`).toBe("https://auth.openai.com/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID_DO_CODEX);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI_DO_CODEX);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("scope")).toBe(ESCOPO_DO_CODEX);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(codeChallengeS256(sessao.codeVerifier));
    expect(url.searchParams.get("state")).toBe(sessao.estado);
    expect(url.searchParams.get("state")!.length).toBeGreaterThanOrEqual(16);
  });

  it("monta a URL com o challenge que quem chamou passou — não com um novo", () => {
    const url = new URL(
      montarUrlDeAutorizacao({ codeChallenge: "DESAFIO_FIXO", estado: "ESTADO_FIXO" }),
    );
    expect(url.searchParams.get("code_challenge")).toBe("DESAFIO_FIXO");
    expect(url.searchParams.get("state")).toBe("ESTADO_FIXO");
  });
});

describe("a troca do code por tokens", () => {
  it("POST com grant_type=authorization_code devolve access_token e refresh_token (fetch falso)", async () => {
    const fetchFalso = vi.fn(async () =>
      resposta(200, {
        access_token: "access_de_troca",
        refresh_token: "refresh_de_troca",
        expires_in: 3600,
      }),
    );

    const tokens = await trocarCodigoPorTokens({
      code: "codigo_colado",
      codeVerifier: gerarCodeVerifier(),
      fetchImpl: fetchFalso,
    });

    expect(tokens.access_token).toBe("access_de_troca");
    expect(tokens.refresh_token).toBe("refresh_de_troca");
    expect(tokens.expires_at).toBeGreaterThan(Date.now());

    expect(fetchFalso).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFalso.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT_DE_TOKEN);
    const corpo = new URLSearchParams(init.body as string);
    expect(corpo.get("grant_type")).toBe("authorization_code");
    expect(corpo.get("code")).toBe("codigo_colado");
    expect(corpo.get("client_id")).toBe(CLIENT_ID_DO_CODEX);
    expect(corpo.get("redirect_uri")).toBe(REDIRECT_URI_DO_CODEX);
    expect(corpo.get("code_verifier")!.length).toBeGreaterThanOrEqual(43);
  });

  it("renovação manda grant_type=refresh_token com o refresh_token atual", async () => {
    const fetchFalso = vi.fn(async () =>
      resposta(200, { access_token: "novo", refresh_token: "novo_refresh", expires_in: 60 }),
    );
    const tokens = await renovarPorRefreshToken({
      refreshToken: "refresh_antigo",
      fetchImpl: fetchFalso,
    });
    expect(tokens.access_token).toBe("novo");
    const chamada = fetchFalso.mock.calls[0] as unknown as [string, RequestInit];
    const corpo = new URLSearchParams(chamada[1].body as string);
    expect(corpo.get("grant_type")).toBe("refresh_token");
    expect(corpo.get("refresh_token")).toBe("refresh_antigo");
  });

  it("recusa do provedor vira erro com motivo, sem vazar o corpo na mensagem", async () => {
    const fetchFalso = vi.fn(async () =>
      resposta(400, { error: "invalid_grant", access_token: "não_deveria_sair" }),
    );
    await expect(
      trocarCodigoPorTokens({
        code: "x",
        codeVerifier: gerarCodeVerifier(),
        fetchImpl: fetchFalso,
      }),
    ).rejects.toThrow();
    try {
      await trocarCodigoPorTokens({
        code: "x",
        codeVerifier: gerarCodeVerifier(),
        fetchImpl: fetchFalso,
      });
    } catch (erro) {
      expect(String(erro)).not.toContain("não_deveria_sair");
    }
  });
});

describe("a renovação proativa", () => {
  it("renova quando faltam menos de 8 dias, e NÃO renova quando ainda falta muito", async () => {
    const agora = Date.now();
    const dentroDaJanela = agora + 2 * 24 * 60 * 60 * 1000;
    const foraDaJanela = agora + 30 * 24 * 60 * 60 * 1000;

    expect(JANELA_DE_RENOVACAO_MS).toBe(8 * 24 * 60 * 60 * 1000);
    expect(renovacaoProxima(dentroDaJanela, agora)).toBe(true);
    expect(renovacaoProxima(foraDaJanela, agora)).toBe(false);
    // Sem prazo conhecido, não decide por conta própria.
    expect(renovacaoProxima(null, agora)).toBe(false);

    const renovar = vi.fn(async () => ({
      access_token: "novo",
      refresh_token: "novo_refresh",
      expires_at: agora + 30 * 24 * 60 * 60 * 1000,
    }));

    await expect(renovarSeProxima({ expiraEm: dentroDaJanela, renovar, agora })).resolves.toBe(
      true,
    );
    expect(renovar).toHaveBeenCalledTimes(1);

    await expect(renovarSeProxima({ expiraEm: foraDaJanela, renovar, agora })).resolves.toBe(false);
    expect(renovar).toHaveBeenCalledTimes(1);
  });
});

describe("o retry único em 401", () => {
  it("401 renova UMA vez e tenta de novo uma vez — e para aí", async () => {
    const statuses = [401, 200];
    const tentar = vi.fn(async () => ({ status: statuses.shift() ?? 200, corpo: "ok" }));
    const renovarApos401 = vi.fn(async () => true);

    const resultado = await chamarComRetryUnicoEm401({ tentar, renovarApos401 });

    expect(resultado.status).toBe(200);
    expect(resultado.tentativas).toBe(2);
    expect(tentar).toHaveBeenCalledTimes(2);
    expect(renovarApos401).toHaveBeenCalledTimes(1);
  });

  it("sem 401 não renova nem tenta de novo", async () => {
    const tentar = vi.fn(async () => ({ status: 200, corpo: "ok" }));
    const renovarApos401 = vi.fn(async () => true);
    const resultado = await chamarComRetryUnicoEm401({ tentar, renovarApos401 });
    expect(resultado.tentativas).toBe(1);
    expect(renovarApos401).not.toHaveBeenCalled();
  });

  it("segundo 401 volta como está — nunca vira loop de retentativas", async () => {
    const tentar = vi.fn(async () => ({ status: 401, corpo: "recusado" }));
    const renovarApos401 = vi.fn(async () => true);
    const resultado = await chamarComRetryUnicoEm401({ tentar, renovarApos401 });
    expect(resultado.status).toBe(401);
    expect(resultado.tentativas).toBe(2);
    expect(tentar).toHaveBeenCalledTimes(2);
    expect(renovarApos401).toHaveBeenCalledTimes(1);
  });
});
