/**
 * Sign in with ChatGPT para apps open source e auto-hospedados (SIWC).
 *
 * A antiga autenticação do Codex CLI era identity-only: os scopes dela não
 * autorizam o plano ChatGPT. Este módulo monta a autorização SIWC e faz as
 * trocas de código/refresh com client_id emitido para cada conta.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

export const CLIENTE_DINAMICO_SIWC = "dynamic_agent_client";
export const RECURSO_SIWC = "https://api.openai.com/v1";
export const ENDPOINT_DE_AUTORIZACAO = "https://auth.openai.com/api/accounts/authorize";
export const ENDPOINT_DE_TOKEN = "https://auth.openai.com/api/accounts/oauth/token";
export const ENDPOINT_DE_JWKS = "https://auth.openai.com/.well-known/jwks.json";
export const REDIRECT_URI_SIWC = "http://127.0.0.1:1455/auth/callback";
export const ESCOPO_SIWC = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const NOME_DO_CLIENTE_SIWC = "DeskcommCRM";
export const CHAVE_DO_HOST_SIWC = "OPENAI_SIWC_EXT_AGENT_HOST_ID";

/** O envelope inteiro continua armazenado cifrado em ai_provider_credentials. */
export interface TokensDoCodex {
  access_token: string;
  refresh_token: string;
  client_id?: string;
  id_token?: string;
  subject?: string;
  email?: string;
  scopes?: string[];
  ext_agent_host_id?: string;
  token_type?: string;
  /** Epoch ms em que o access_token vence. */
  expires_at: number | null;
}

export type FetchDeToken = (url: string, init?: RequestInit) => Promise<Response>;
const fetchDaPlataforma: FetchDeToken = (url, init) => fetch(url, init);

export interface SessaoPkce {
  codeVerifier: string;
  estado: string;
  nonce: string;
  url: string;
}

export function gerarNonceSiwc(): string {
  return randomBytes(24).toString("base64url");
}

/** RFC 7636 §4.1 — 43 a 128 caracteres, sem `=` nem `+`/`/`. */
export function gerarCodeVerifier(): string {
  return randomBytes(48).toString("base64url");
}

export function codeChallengeS256(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

export function criarSessaoPkce(
  estado: string,
  opcoes: { nonce: string; clientId?: string; extAgentHostId: string },
): SessaoPkce {
  const codeVerifier = gerarCodeVerifier();
  return {
    codeVerifier,
    estado,
    nonce: opcoes.nonce,
    url: montarUrlDeAutorizacao({
      codeChallenge: codeChallengeS256(codeVerifier),
      estado,
      nonce: opcoes.nonce,
      ...(opcoes.clientId ? { clientId: opcoes.clientId } : {}),
      extAgentHostId: opcoes.extAgentHostId,
    }),
  };
}

export function montarUrlDeAutorizacao(entrada: {
  codeChallenge: string;
  estado: string;
  nonce: string;
  clientId?: string;
  extAgentHostId: string;
  redirectUri?: string;
}): string {
  const clientId = entrada.clientId ?? CLIENTE_DINAMICO_SIWC;
  const parametros = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: entrada.redirectUri ?? REDIRECT_URI_SIWC,
    scope: ESCOPO_SIWC,
    resource: RECURSO_SIWC,
    nonce: entrada.nonce,
    ext_agent_host_id: entrada.extAgentHostId,
    code_challenge: entrada.codeChallenge,
    code_challenge_method: "S256",
    state: entrada.estado,
  });
  if (!entrada.clientId) parametros.set("agent_name_hint", NOME_DO_CLIENTE_SIWC);
  return `${ENDPOINT_DE_AUTORIZACAO}?${parametros.toString()}`;
}

/** A instalação mantém um UUID estável na tabela platform_config. */
export function novoHostIdSiwc(): string {
  return `urn:uuid:${randomUUID()}`;
}

export function lerRetornoColado(
  texto: string,
): { code: string; state: string; clientId?: string; error?: string } | null {
  const limpo = texto.trim();
  const inicio = limpo.indexOf("?");
  const consulta = inicio >= 0 ? limpo.slice(inicio + 1) : limpo.includes("=") ? limpo : "";
  if (consulta === "") return null;
  const parametros = new URLSearchParams(consulta.split("#")[0]);
  const state = parametros.get("state")?.trim() ?? "";
  if (state === "") return null;
  const code = parametros.get("code")?.trim() ?? "";
  const clientId = parametros.get("client_id")?.trim();
  const error = parametros.get("error")?.trim();
  if (!code && !error) return null;
  return {
    code,
    state,
    ...(clientId ? { clientId } : {}),
    ...(error ? { error } : {}),
  };
}

export type MotivoDeFalhaDeToken = "refresh_token_revoked" | "recusado" | "rede";

export class ErroDeToken extends Error {
  constructor(
    readonly motivo: MotivoDeFalhaDeToken,
    readonly status: number | null,
    detalhe?: string,
  ) {
    super(detalhe ?? `falha na troca de token (${status ?? "sem resposta"})`);
    this.name = "ErroDeToken";
  }
}

export function classificarFalhaDeToken(status: number | null, corpo: unknown): MotivoDeFalhaDeToken {
  if (status === null) return "rede";
  const erro = (corpo as { error?: unknown; error_description?: unknown } | null) ?? {};
  const texto = `${String(erro.error ?? "")} ${String(erro.error_description ?? "")}`.toLowerCase();
  if (texto.includes("revoked") || texto.includes("revog")) return "refresh_token_revoked";
  return "recusado";
}

async function trocar(entrada: {
  corpo: Record<string, string>;
  fetchImpl: FetchDeToken;
}): Promise<TokensDoCodex> {
  let resposta: Response;
  try {
    resposta = await entrada.fetchImpl(ENDPOINT_DE_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(entrada.corpo).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (erro) {
    throw new ErroDeToken("rede", null, erro instanceof Error ? erro.message : String(erro));
  }

  let corpo: unknown = null;
  try {
    corpo = await resposta.json();
  } catch {
    corpo = null;
  }
  const dados = corpo as {
    access_token?: unknown;
    refresh_token?: unknown;
    id_token?: unknown;
    token_type?: unknown;
    scope?: unknown;
    expires_in?: unknown;
  } | null;
  if (
    !resposta.ok ||
    typeof dados?.access_token !== "string" ||
    typeof dados.refresh_token !== "string"
  ) {
    throw new ErroDeToken(
      classificarFalhaDeToken(resposta.ok ? 400 : resposta.status, corpo),
      resposta.status,
    );
  }
  const segundos = typeof dados.expires_in === "number" ? dados.expires_in : null;
  return {
    access_token: dados.access_token,
    refresh_token: dados.refresh_token,
    ...(typeof dados.id_token === "string" ? { id_token: dados.id_token } : {}),
    ...(typeof dados.token_type === "string" ? { token_type: dados.token_type } : {}),
    ...(typeof dados.scope === "string" ? { scopes: dados.scope.split(/\s+/).filter(Boolean) } : {}),
    expires_at: segundos === null ? null : Date.now() + segundos * 1000,
  };
}

export function trocarCodigoPorTokens(entrada: {
  code: string;
  codeVerifier: string;
  clientId: string;
  redirectUri?: string;
  fetchImpl?: FetchDeToken;
}): Promise<TokensDoCodex> {
  return trocar({
    fetchImpl: entrada.fetchImpl ?? fetchDaPlataforma,
    corpo: {
      grant_type: "authorization_code",
      code: entrada.code,
      redirect_uri: entrada.redirectUri ?? REDIRECT_URI_SIWC,
      client_id: entrada.clientId,
      code_verifier: entrada.codeVerifier,
      resource: RECURSO_SIWC,
    },
  });
}

export function renovarPorRefreshToken(entrada: {
  refreshToken: string;
  clientId: string;
  fetchImpl?: FetchDeToken;
}): Promise<TokensDoCodex> {
  return trocar({
    fetchImpl: entrada.fetchImpl ?? fetchDaPlataforma,
    corpo: {
      grant_type: "refresh_token",
      refresh_token: entrada.refreshToken,
      client_id: entrada.clientId,
      resource: RECURSO_SIWC,
    },
  });
}
