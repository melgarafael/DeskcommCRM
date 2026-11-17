/**
 * POST /api/mcp/oauth/revoke — revogação de token (RFC 7009).
 *
 * Aceita o refresh token ou o access token (`dsk_…`) e desliga a conexão
 * inteira — só a do PRÓPRIO cliente autenticado. Token desconhecido responde
 * 200 do mesmo jeito (RFC 7009 §2.2): a resposta não diz se ele existia.
 *
 * A outra saída de uma conexão é a tela: revogar a linha em Configurações ›
 * Tokens de API derruba a próxima renovação (`fn_mcp_oauth_renovar`).
 *
 * Público no `proxy` pela entrada `/api/mcp(\/.*)?$` de `lib/auth/public-paths.ts`.
 */
import { randomUUID } from "node:crypto";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { autenticarCliente } from "@/lib/mcp/oauth/clientes";
import { lerCorpoOAuth, pedidoDeRevogacaoSchema } from "@/lib/mcp/oauth/esquemas";
import { oauthMcpLimitado } from "@/lib/mcp/oauth/limites";
import { erroOAuth } from "@/lib/mcp/oauth/respostas";
import { byteaDoHash } from "@/lib/mcp/oauth/segredos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  if (await oauthMcpLimitado("revogacao")) {
    return erroOAuth("slow_down", "Too many revocation requests. Try again later.", 429, requestId);
  }

  const corpo = await lerCorpoOAuth(req);
  const parsed = corpo ? pedidoDeRevogacaoSchema.safeParse(corpo) : null;
  if (!parsed?.success) return erroOAuth("invalid_request", "Missing 'token'.", 400, requestId);

  const admin = createAdminClient();
  const cliente = await autenticarCliente(admin, parsed.data, req.headers.get("authorization"));
  if (!cliente) return erroOAuth("invalid_client", "Client authentication failed.", 401, requestId);

  const { data, error } = await admin.rpc("fn_mcp_oauth_revogar", {
    p_hash: byteaDoHash(parsed.data.token),
    p_cliente: cliente.id,
  });
  if (error) {
    logger.error("[mcp-oauth.revoke] rpc failed", { request_id: requestId, error: error.message });
    return erroOAuth("server_error", "Could not revoke the token.", 500, requestId);
  }

  const linha = (Array.isArray(data) ? data[0] : data) as
    | { organization_id: string; api_token_id: string; concessao_id: string }
    | undefined;
  if (linha?.organization_id) {
    await audit({
      action: "mcp_oauth.revogado",
      actorApiTokenId: linha.api_token_id,
      organizationId: linha.organization_id,
      resourceType: "mcp_oauth_concessao",
      resourceId: linha.concessao_id,
      requestId,
      metadata: { client_name: cliente.nome, via: "revocation_endpoint" },
    });
  }

  return new Response(null, { status: 200, headers: { "cache-control": "no-store", "X-Request-Id": requestId } });
}
