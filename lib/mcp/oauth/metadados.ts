/**
 * Os documentos de descoberta e o desafio do 401 — puros, sem I/O.
 *
 * O cliente de MCP descobre tudo por eles: bate no `/api/mcp` sem token, lê o
 * `WWW-Authenticate` do 401, segue `resource_metadata` até o documento do
 * recurso (RFC 9728), dali ao servidor de autorização (RFC 8414), registra-se
 * (RFC 7591) e abre a tela de consentimento.
 */
import { ESCOPOS_MCP, type EnderecosOAuth } from "./config";

export const METODOS_DE_AUTENTICACAO = ["none", "client_secret_post", "client_secret_basic"] as const;

export function metadadosDoRecurso(e: EnderecosOAuth) {
  return {
    resource: e.recurso,
    authorization_servers: [e.issuer],
    scopes_supported: [...ESCOPOS_MCP],
    bearer_methods_supported: ["header"],
  };
}

export function metadadosDoServidor(e: EnderecosOAuth) {
  return {
    issuer: e.issuer,
    authorization_endpoint: e.autorizacao,
    token_endpoint: e.token,
    registration_endpoint: e.registro,
    revocation_endpoint: e.revogacao,
    scopes_supported: [...ESCOPOS_MCP],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [...METODOS_DE_AUTENTICACAO],
    revocation_endpoint_auth_methods_supported: [...METODOS_DE_AUTENTICACAO],
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * O desafio do 401 do `/api/mcp` (RFC 9728 §5.1). Sem ele o cliente não sabe
 * que existe OAuth aqui: o ChatGPT mostra "não foi possível conectar".
 * `invalid_token` só quando um token FOI apresentado (RFC 6750 §3.1).
 */
export function desafioBearer(e: EnderecosOAuth, tokenApresentado: boolean): string {
  const partes = [
    `resource_metadata="${e.metadadosDoRecurso}"`,
    `scope="${ESCOPOS_MCP.join(" ")}"`,
  ];
  if (tokenApresentado) partes.push(`error="invalid_token"`);
  return `Bearer ${partes.join(", ")}`;
}

/** Cabeçalhos dos documentos de descoberta: públicos, legíveis de qualquer origem. */
export const CABECALHOS_DE_DESCOBERTA = {
  "content-type": "application/json",
  "cache-control": "public, max-age=300",
  "access-control-allow-origin": "*",
} as const;
