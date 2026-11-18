/**
 * GET /.well-known/oauth-authorization-server — metadados do servidor de
 * autorização do MCP (RFC 8414): onde registrar o cliente, abrir o
 * consentimento, trocar o código e revogar. Documento estático, sem banco —
 * público e sem limite de taxa próprio.
 */
import { enderecosOAuth } from "@/lib/mcp/oauth/config";
import { CABECALHOS_DE_DESCOBERTA, metadadosDoServidor } from "@/lib/mcp/oauth/metadados";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(JSON.stringify(metadadosDoServidor(enderecosOAuth())), {
    status: 200,
    headers: CABECALHOS_DE_DESCOBERTA,
  });
}
