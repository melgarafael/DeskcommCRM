/**
 * Os dois endereços PÚBLICOS do OAuth por contato, derivados da URL pública já
 * configurada na instalação (`NEXT_PUBLIC_APP_URL`) — nunca de cabeçalho da
 * requisição (um `Host` forjado mudaria o `redirect_uri` registrado). Nenhuma
 * variável de ambiente nova: o self-host que já tem a URL pública tem os dois.
 *
 * - `/api/v1/mcp-oauth/iniciar/<state>`: o link CURTO que vai no WhatsApp; ele
 *   confere validade e uso e responde 302 para o authorization server. Legível
 *   na conversa e sem expor parâmetro nenhum do OAuth.
 * - `/api/v1/mcp-oauth/callback`: a volta do authorization server — a mesma
 *   para todo servidor e todo contato, é a `redirect_uri` registrada no DCR.
 */
import { env } from "@/lib/env";

export const CAMINHO_DO_CALLBACK_MCP = "/api/v1/mcp-oauth/callback";
export const CAMINHO_DO_INICIO_MCP = "/api/v1/mcp-oauth/iniciar";

function base(): string {
  return (env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
}

export function urlDoCallbackMcp(): string {
  return `${base()}${CAMINHO_DO_CALLBACK_MCP}`;
}

export function urlDeInicioMcp(state: string): string {
  return `${base()}${CAMINHO_DO_INICIO_MCP}/${encodeURIComponent(state)}`;
}
