/**
 * GET /.well-known/oauth-protected-resource/api/mcp — a forma com o caminho do
 * recurso inserido (RFC 9728 §3.1). Clientes que não leem o `WWW-Authenticate`
 * derivam este endereço da URL do MCP; o documento é o mesmo.
 */
export { GET } from "../../route";

export const dynamic = "force-dynamic";
