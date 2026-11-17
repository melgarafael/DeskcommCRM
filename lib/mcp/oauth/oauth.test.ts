/**
 * As peças puras do OAuth do MCP (migration 9390): descoberta, desafio do 401,
 * escopos, régua de redirect_uri, esquemas e segredos.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { credenciaisBasic } from "./clientes";
import { enderecosOAuth, escoposPedidos, escritaOferecida, recursoConfere } from "./config";
import { pedidoDeAutorizacaoSchema, pedidoDeTokenSchema, redirectUriAceitavel } from "./esquemas";
import { desafioBearer, metadadosDoRecurso, metadadosDoServidor } from "./metadados";
import { urlDeVoltaComCodigo, urlDeVoltaComErro } from "./respostas";
import { byteaDoHash, novoAccessToken, novoClientId, novoCodigo, novoRefresh, segredoConfere } from "./segredos";

const E = enderecosOAuth("https://crm.exemplo.com");
const DESAFIO = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("descoberta (RFC 9728 / RFC 8414)", () => {
  it("o recurso aponta o próprio CRM como servidor de autorização", () => {
    expect(metadadosDoRecurso(E)).toEqual({
      resource: "https://crm.exemplo.com/api/mcp",
      authorization_servers: ["https://crm.exemplo.com"],
      scopes_supported: ["mcp:read", "mcp:write"],
      bearer_methods_supported: ["header"],
    });
  });

  it("o servidor anuncia só código + PKCE S256, com registro e revogação", () => {
    const m = metadadosDoServidor(E);
    expect(m.issuer).toBe("https://crm.exemplo.com");
    expect(m.authorization_endpoint).toBe("https://crm.exemplo.com/api/mcp/oauth/authorize");
    expect(m.token_endpoint).toBe("https://crm.exemplo.com/api/mcp/oauth/token");
    expect(m.registration_endpoint).toBe("https://crm.exemplo.com/api/mcp/oauth/register");
    expect(m.revocation_endpoint).toBe("https://crm.exemplo.com/api/mcp/oauth/revoke");
    expect(m.response_types_supported).toEqual(["code"]);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  });

  it("o desafio do 401 aponta os metadados e só diz invalid_token quando houve token", () => {
    expect(desafioBearer(E, false)).toBe(
      'Bearer resource_metadata="https://crm.exemplo.com/.well-known/oauth-protected-resource", scope="mcp:read mcp:write"',
    );
    expect(desafioBearer(E, true)).toContain('error="invalid_token"');
  });
});

describe("escopos e recurso", () => {
  it("só os escopos do MCP contam; desconhecidos são ignorados", () => {
    expect(escoposPedidos("openid mcp:write offline_access mcp:read")).toEqual(["mcp:read", "mcp:write"]);
    expect(escoposPedidos(undefined)).toEqual([]);
  });

  it("escrita é oferecida quando pedida ou quando nada específico foi pedido", () => {
    expect(escritaOferecida([])).toBe(true);
    expect(escritaOferecida(["mcp:read"])).toBe(false);
    expect(escritaOferecida(["mcp:read", "mcp:write"])).toBe(true);
  });

  it("resource (RFC 8707) tem de ser este MCP — barra final tolerada", () => {
    expect(recursoConfere(undefined, E.recurso)).toBe(true);
    expect(recursoConfere("https://crm.exemplo.com/api/mcp/", E.recurso)).toBe(true);
    expect(recursoConfere("https://outro.exemplo.com/api/mcp", E.recurso)).toBe(false);
  });
});

describe("redirect_uri", () => {
  it.each([
    ["https://chatgpt.com/connector_platform_oauth_redirect", true],
    ["http://localhost:6274/oauth/callback", true],
    ["http://127.0.0.1:33418/cb", true],
    ["http://evil.example/cb", false],
    ["https://chatgpt.com/cb#frag", false],
    ["meuapp://callback", false],
    ["https://user:senha@chatgpt.com/cb", false],
    ["não é url", false],
  ])("%s → %s", (uri, esperado) => {
    expect(redirectUriAceitavel(uri)).toBe(esperado);
  });
});

describe("esquemas", () => {
  const base = {
    response_type: "code",
    client_id: novoClientId(),
    redirect_uri: "https://chatgpt.com/cb",
    code_challenge: DESAFIO,
    code_challenge_method: "S256",
  };

  it("pedido de autorização exige PKCE S256", () => {
    expect(pedidoDeAutorizacaoSchema.safeParse(base).success).toBe(true);
    expect(pedidoDeAutorizacaoSchema.safeParse({ ...base, code_challenge_method: "plain" }).success).toBe(false);
    const { code_challenge: _c, ...semDesafio } = base;
    expect(pedidoDeAutorizacaoSchema.safeParse(semDesafio).success).toBe(false);
    expect(pedidoDeAutorizacaoSchema.safeParse({ ...base, response_type: "token" }).success).toBe(false);
  });

  it("token: authorization_code exige code_verifier; refresh exige refresh_token", () => {
    expect(
      pedidoDeTokenSchema.safeParse({ grant_type: "authorization_code", code: "dco_x", redirect_uri: "https://a/b" })
        .success,
    ).toBe(false);
    expect(
      pedidoDeTokenSchema.safeParse({
        grant_type: "authorization_code",
        code: "dco_x",
        redirect_uri: "https://a/b",
        code_verifier: "a".repeat(43),
      }).success,
    ).toBe(true);
    expect(pedidoDeTokenSchema.safeParse({ grant_type: "refresh_token" }).success).toBe(false);
  });
});

describe("segredos", () => {
  it("formatos: dcc_ cabe no CHECK da tabela; o access token é um dsk_ como os da tela", () => {
    expect(novoClientId()).toMatch(/^dcc_[A-Za-z0-9_-]{32}$/);
    expect(novoCodigo()).toMatch(/^dco_[A-Za-z0-9_-]{43}$/);
    expect(novoRefresh()).toMatch(/^dsr_[A-Za-z0-9_-]{43}$/);
    const t = novoAccessToken();
    expect(t.prefixo).toMatch(/^dsk_[0-9a-f]{8}$/);
    expect(t.plaintext.startsWith(`${t.prefixo}_`)).toBe(true);
  });

  it("o banco recebe só o SHA-256, e a conferência é exata", () => {
    const segredo = "dcs_abc";
    const guardado = byteaDoHash(segredo);
    expect(guardado).toBe(`\\x${createHash("sha256").update(segredo).digest("hex")}`);
    expect(guardado).not.toContain(segredo);
    expect(segredoConfere(segredo, guardado)).toBe(true);
    expect(segredoConfere("dcs_abd", guardado)).toBe(false);
    expect(segredoConfere(segredo, null)).toBe(false);
  });

  it("Basic auth: id e segredo url-encoded (RFC 6749 §2.3.1)", () => {
    const valor = Buffer.from(`${encodeURIComponent("dcc_x")}:${encodeURIComponent("a:b%c")}`).toString("base64");
    expect(credenciaisBasic(`Basic ${valor}`)).toEqual({ clientId: "dcc_x", segredo: "a:b%c" });
    expect(credenciaisBasic("Bearer xyz")).toBeNull();
  });
});

describe("volta ao cliente", () => {
  it("leva code, state e iss (RFC 9207), preservando a query do endereço registrado", () => {
    const u = new URL(urlDeVoltaComCodigo("https://chatgpt.com/cb?x=1", "dco_1", "st", E.issuer));
    expect(u.searchParams.get("x")).toBe("1");
    expect(u.searchParams.get("code")).toBe("dco_1");
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("iss")).toBe("https://crm.exemplo.com");
  });

  it("erro sem state não inventa state", () => {
    const u = new URL(urlDeVoltaComErro("https://chatgpt.com/cb", "access_denied", undefined, E.issuer));
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.has("state")).toBe(false);
  });
});

describe("nome declarado pelo cliente no registro", () => {
  it("tira direção bidi, marcas e controles, junta espaços e corta", async () => {
    const { nomeDeClienteLimpo, TETO_DO_NOME_DO_CLIENTE } = await import("./esquemas");
    expect(nomeDeClienteLimpo("Chat‮GPT‬")).toBe("ChatGPT");
    expect(nomeDeClienteLimpo("⁦Meu⁩ app‎‏")).toBe("Meu app");
    expect(nomeDeClienteLimpo("  Chat\n\tGPT \u0000\u001b[31m  ")).toBe("Chat GPT [31m");
    expect(nomeDeClienteLimpo("a b  c")).toBe("a b c");
    expect(nomeDeClienteLimpo("​‮ ")).toBe("");
    const longo = nomeDeClienteLimpo("x".repeat(500));
    expect(Array.from(longo)).toHaveLength(TETO_DO_NOME_DO_CLIENTE);
    expect(nomeDeClienteLimpo("Ação 🚀 Ü")).toBe("Ação 🚀 Ü");
  });

  it("o esquema do registro devolve o nome limpo, e nome só de invisíveis vira ausente", async () => {
    const { pedidoDeRegistroSchema } = await import("./esquemas");
    const base = { redirect_uris: ["https://chatgpt.com/cb"] };
    expect(pedidoDeRegistroSchema.parse({ ...base, client_name: "Chat‮GPT" }).client_name).toBe("ChatGPT");
    expect(pedidoDeRegistroSchema.parse({ ...base, client_name: "‮‏" }).client_name).toBeUndefined();
  });
});
