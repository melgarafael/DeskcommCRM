/**
 * POST /api/mcp/oauth/token — troca do código e renovação (RFC 6749 §4.1.3 e §6).
 *
 * Quem chama é o SERVIDOR do cliente (ChatGPT), nunca o navegador. O access
 * token devolvido é um `dsk_…` de `api_tokens`: o `/api/mcp` o valida pelo
 * caminho de sempre (`lib/mcp/auth.ts`), com o mesmo ator, papel, escopos,
 * auditoria e isolamento dos tokens de servidor. As regras que decidem — PKCE,
 * uso único, a pessoa ainda administra a organização, o token não foi revogado
 * na tela — moram no banco (`fn_mcp_oauth_trocar_codigo`,
 * `fn_mcp_oauth_renovar`), numa transação só.
 *
 * Público no `proxy` pela entrada `/api/mcp(\/.*)?$` de `lib/auth/public-paths.ts`.
 */
import { randomUUID } from "node:crypto";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { autenticarCliente } from "@/lib/mcp/oauth/clientes";
import { enderecosOAuth, escoposPedidos, PRAZOS, recursoConfere } from "@/lib/mcp/oauth/config";
import { lerCorpoOAuth, pedidoDeTokenSchema } from "@/lib/mcp/oauth/esquemas";
import { oauthMcpLimitado } from "@/lib/mcp/oauth/limites";
import { erroOAuth, respostaOAuth } from "@/lib/mcp/oauth/respostas";
import { byteaDoHash, novoAccessToken, novoRefresh } from "@/lib/mcp/oauth/segredos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface LinhaDaEmissao {
  motivo: string | null;
  organization_id: string | null;
  api_token_id: string | null;
  concessao_id: string | null;
  escopos: string[] | null;
}

function emSegundos(agora: number, segundos: number): string {
  return new Date(agora + segundos * 1000).toISOString();
}

export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  if (await oauthMcpLimitado("token")) {
    return erroOAuth("slow_down", "Too many token requests. Try again in a few minutes.", 429, requestId);
  }

  const corpo = await lerCorpoOAuth(req);
  if (!corpo) return erroOAuth("invalid_request", "Unreadable request body.", 400, requestId);
  if (corpo.grant_type !== "authorization_code" && corpo.grant_type !== "refresh_token") {
    return erroOAuth("unsupported_grant_type", "Use authorization_code or refresh_token.", 400, requestId);
  }
  const parsed = pedidoDeTokenSchema.safeParse(corpo);
  if (!parsed.success) {
    return erroOAuth(
      "invalid_request",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      400,
      requestId,
    );
  }
  const pedido = parsed.data;
  const e = enderecosOAuth();
  if (!recursoConfere(pedido.resource, e.recurso)) {
    return erroOAuth("invalid_target", `This server only issues tokens for ${e.recurso}.`, 400, requestId);
  }

  const admin = createAdminClient();
  const cliente = await autenticarCliente(admin, pedido, req.headers.get("authorization"));
  if (!cliente) return erroOAuth("invalid_client", "Client authentication failed.", 401, requestId);

  const agora = Date.now();
  const acesso = novoAccessToken();
  const refresh = novoRefresh();
  const tokenExpiraEm = emSegundos(agora, PRAZOS.acesso);
  const refreshExpiraEm = emSegundos(agora, PRAZOS.refresh);

  const { data, error } =
    pedido.grant_type === "authorization_code"
      ? await admin.rpc("fn_mcp_oauth_trocar_codigo", {
          p_codigo_hash: byteaDoHash(pedido.code),
          p_cliente: cliente.id,
          p_redirect_uri: pedido.redirect_uri,
          p_code_verifier: pedido.code_verifier,
          p_token_hash: byteaDoHash(acesso.plaintext),
          p_prefixo: acesso.prefixo,
          p_token_expira_em: tokenExpiraEm,
          p_refresh_hash: byteaDoHash(refresh),
          p_refresh_expira_em: refreshExpiraEm,
          p_nome: `${cliente.nome} (OAuth)`,
        })
      : await admin.rpc("fn_mcp_oauth_renovar", {
          p_refresh_hash: byteaDoHash(pedido.refresh_token),
          p_cliente: cliente.id,
          p_novo_refresh_hash: byteaDoHash(refresh),
          p_token_hash: byteaDoHash(acesso.plaintext),
          p_prefixo: acesso.prefixo,
          p_token_expira_em: tokenExpiraEm,
          p_refresh_expira_em: refreshExpiraEm,
          // Sem escopo do MCP no pedido = mantém o concedido.
          p_escopos: escoposPedidos(pedido.scope).length ? escoposPedidos(pedido.scope) : null,
        });

  if (error) {
    // O teto de tokens ativos da organização (migration 0415) é a única recusa
    // que a função deixa escapar como exceção — e ela tem instrução própria.
    if (error.code === "PT409") {
      return erroOAuth("temporarily_unavailable", error.message, 400, requestId);
    }
    logger.error("[mcp-oauth.token] rpc failed", { request_id: requestId, grant_type: pedido.grant_type, error: error.message });
    return erroOAuth("server_error", "Could not issue the token.", 500, requestId);
  }

  const linha = (Array.isArray(data) ? data[0] : data) as LinhaDaEmissao | undefined;
  if (!linha || linha.motivo || !linha.api_token_id || !linha.organization_id) {
    const motivo = linha?.motivo === "invalid_scope" ? "invalid_scope" : "invalid_grant";
    return erroOAuth(
      motivo,
      motivo === "invalid_scope"
        ? "Requested scope exceeds what was granted."
        : "The code or refresh token is invalid, expired, already used or revoked. Reconnect to authorize again.",
      400,
      requestId,
    );
  }

  const escopos = linha.escopos ?? [];
  await audit({
    action: pedido.grant_type === "authorization_code" ? "mcp_oauth.token_emitido" : "mcp_oauth.token_renovado",
    actorApiTokenId: linha.api_token_id,
    organizationId: linha.organization_id,
    resourceType: "mcp_oauth_concessao",
    resourceId: linha.concessao_id,
    requestId,
    metadata: { client_name: cliente.nome, escopos, prefix: acesso.prefixo },
  });

  return respostaOAuth(
    {
      access_token: acesso.plaintext,
      token_type: "Bearer",
      expires_in: PRAZOS.acesso,
      refresh_token: refresh,
      scope: escopos.join(" "),
    },
    200,
    requestId,
  );
}
