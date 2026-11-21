/**
 * GET /.well-known/oauth-protected-resource — metadados do recurso MCP (RFC 9728).
 *
 * É o endereço que o `WWW-Authenticate` do 401 do `/api/mcp` aponta. Diz ao
 * cliente qual servidor de autorização emite tokens para este recurso (o
 * próprio CRM). Documento estático, sem banco e sem dado de organização — por
 * isso público (`lib/auth/public-paths.ts`) e sem limite de taxa próprio.
 */
import { enderecosOAuth } from "@/lib/mcp/oauth/config";
import { CABECALHOS_DE_DESCOBERTA, metadadosDoRecurso } from "@/lib/mcp/oauth/metadados";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(JSON.stringify(metadadosDoRecurso(enderecosOAuth())), {
    status: 200,
    headers: CABECALHOS_DE_DESCOBERTA,
  });
}
