/**
 * OAuth 2.1 do MCP do CRM — endereços, escopos e prazos.
 *
 * O CRM é o servidor de autorização do PRÓPRIO recurso (`/api/mcp`), seguindo a
 * especificação de autorização do MCP: metadados do recurso (RFC 9728), do
 * servidor (RFC 8414), registro dinâmico (RFC 7591), código com PKCE S256 e
 * rotação de refresh token. Existe porque o ChatGPT (e outros clientes) não
 * deixa colar um `Authorization: Bearer dsk_…` — só oferece OAuth ou "sem
 * autenticação" — e chave na URL é proibida (anti-pattern 12).
 *
 * A ORIGEM vem de `NEXT_PUBLIC_APP_URL`, nunca do `Host` da requisição: o
 * `issuer` e o `resource` são o que o cliente confere, e um cabeçalho forjado
 * não pode escolher para onde o consentimento aponta. Instalação com
 * `NEXT_PUBLIC_APP_URL` errado anuncia endereços errados — e o cliente recusa,
 * em vez de conectar no lugar errado.
 */
import { env } from "@/lib/env";

export const ESCOPOS_MCP = ["mcp:read", "mcp:write"] as const;
export type EscopoMcp = (typeof ESCOPOS_MCP)[number];

/** Prazos, em segundos. */
export const PRAZOS = {
  /** Código de autorização: uso único, o suficiente para o redirecionamento. */
  codigo: 5 * 60,
  /** Access token (`dsk_…`): curto, porque é o que viaja em toda chamada. */
  acesso: 60 * 60,
  /** Refresh token: renovado a cada uso; conexão parada 60 dias pede novo consentimento. */
  refresh: 60 * 24 * 60 * 60,
} as const;

export interface EnderecosOAuth {
  issuer: string;
  recurso: string;
  autorizacao: string;
  token: string;
  registro: string;
  revogacao: string;
  metadadosDoRecurso: string;
  metadadosDoServidor: string;
}

/** Origem pública da instalação (`https://crm.exemplo.com`), sem barra no fim. */
export function origemPublica(): string {
  return new URL(env.NEXT_PUBLIC_APP_URL).origin;
}

export function enderecosOAuth(origem: string = origemPublica()): EnderecosOAuth {
  return {
    issuer: origem,
    recurso: `${origem}/api/mcp`,
    autorizacao: `${origem}/api/mcp/oauth/authorize`,
    token: `${origem}/api/mcp/oauth/token`,
    registro: `${origem}/api/mcp/oauth/register`,
    revogacao: `${origem}/api/mcp/oauth/revoke`,
    metadadosDoRecurso: `${origem}/.well-known/oauth-protected-resource`,
    metadadosDoServidor: `${origem}/.well-known/oauth-authorization-server`,
  };
}

/**
 * `scope` do pedido (lista separada por espaço) → escopos do MCP que ele cita.
 * Escopo desconhecido é ignorado, não recusado: clientes pedem `openid` ou
 * `offline_access` por hábito, e recusar por isso só tranca quem conecta.
 * Pedido vazio = "o que a pessoa escolher na tela".
 */
export function escoposPedidos(scope: string | null | undefined): EscopoMcp[] {
  if (!scope) return [];
  const pedidos = new Set(scope.split(/\s+/).filter(Boolean));
  return ESCOPOS_MCP.filter((e) => pedidos.has(e));
}

/** Escrita é oferecida quando o cliente a pediu — ou não pediu nada específico. */
export function escritaOferecida(pedidos: readonly EscopoMcp[]): boolean {
  return pedidos.length === 0 || pedidos.includes("mcp:write");
}

/** O recurso pedido (RFC 8707) é este MCP? Ausente vale: o recurso é implícito. */
export function recursoConfere(pedido: string | null | undefined, recurso: string): boolean {
  if (!pedido) return true;
  return pedido.replace(/\/+$/, "") === recurso.replace(/\/+$/, "");
}
