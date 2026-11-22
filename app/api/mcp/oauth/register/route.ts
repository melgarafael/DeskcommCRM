/**
 * POST /api/mcp/oauth/register — registro dinâmico de cliente (RFC 7591).
 *
 * Aberto por definição: o ChatGPT registra a si mesmo antes de abrir o
 * consentimento. Registrar NÃO dá acesso a nada — o acesso nasce só quando uma
 * pessoa que administra a organização permite, na tela de consentimento, que
 * mostra o nome declarado e o host de volta. Por isso o cliente vive sem
 * organização (`mcp_oauth_clientes`), o registro é limitado por IP e por um
 * teto de clientes nunca autorizados, e quem não foi autorizado em 24 h é
 * apagado pela poda diária (`fn_mcp_oauth_podar`, cron `data-retention`).
 *
 * Público no `proxy` pela entrada `/api/mcp(\/.*)?$` de `lib/auth/public-paths.ts`.
 */
import { randomUUID } from "node:crypto";

import { audit } from "@/lib/audit";
import { oauthMcpLimitado, TETO_DE_CLIENTES_PENDENTES } from "@/lib/mcp/oauth/limites";
import { pedidoDeRegistroSchema, TETO_DO_CORPO_DE_REGISTRO } from "@/lib/mcp/oauth/esquemas";
import { erroOAuth, respostaOAuth } from "@/lib/mcp/oauth/respostas";
import { byteaDoHash, novoClientId, novoSegredoDeCliente } from "@/lib/mcp/oauth/segredos";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  if (await oauthMcpLimitado("registro")) {
    return erroOAuth("slow_down", "Too many client registrations. Try again later.", 429, requestId);
  }

  const texto = await req.text().catch(() => null);
  if (texto !== null && texto.length > TETO_DO_CORPO_DE_REGISTRO) {
    return erroOAuth("invalid_client_metadata", "Body too large.", 413, requestId);
  }
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto ?? "");
  } catch {
    return erroOAuth("invalid_client_metadata", "Body must be JSON.", 400, requestId);
  }
  const parsed = pedidoDeRegistroSchema.safeParse(bruto);
  if (!parsed.success) {
    const redirect = parsed.error.issues.some((i) => i.path[0] === "redirect_uris");
    return erroOAuth(
      redirect ? "invalid_redirect_uri" : "invalid_client_metadata",
      parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      400,
      requestId,
    );
  }
  const pedido = parsed.data;
  if (pedido.grant_types?.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    return erroOAuth("invalid_client_metadata", "Only authorization_code and refresh_token grants are supported.", 400, requestId);
  }
  if (pedido.response_types?.some((r) => r !== "code")) {
    return erroOAuth("invalid_client_metadata", "Only the 'code' response type is supported.", 400, requestId);
  }

  const metodo = pedido.token_endpoint_auth_method ?? "none";
  const clientId = novoClientId();
  const segredo = metodo === "none" ? null : novoSegredoDeCliente();
  const nome = pedido.client_name ?? "Cliente MCP";

  const admin = createAdminClient();
  // Teto de pendentes, despejo e insert numa transação só, sob lock: ver
  // `fn_mcp_oauth_registrar_cliente` (migration 9390).
  const { data: linhas, error } = await admin.rpc("fn_mcp_oauth_registrar_cliente", {
    p_client_id: clientId,
    p_client_secret_hash: segredo ? byteaDoHash(segredo) : null,
    p_nome: nome,
    p_redirect_uris: pedido.redirect_uris,
    p_metodo: metodo,
    p_teto: TETO_DE_CLIENTES_PENDENTES,
  });
  const data = (Array.isArray(linhas) ? linhas[0] : linhas) as
    | { motivo: string | null; id: string | null; created_at: string | null; despejados: number }
    | undefined;
  if (error || !data) {
    logger.error("[mcp-oauth.register] insert failed", { request_id: requestId, error: error?.message });
    return erroOAuth("server_error", "Could not register the client.", 500, requestId);
  }
  if (!data.id || !data.created_at) {
    logger.error("[mcp-oauth.register] no row returned", { request_id: requestId });
    return erroOAuth("server_error", "Could not register the client.", 500, requestId);
  }
  const despejados = data.despejados;

  await audit({
    action: "mcp_oauth.cliente_registrado",
    organizationId: null,
    resourceType: "mcp_oauth_cliente",
    resourceId: data.id,
    requestId,
    metadata: {
      client_name: nome,
      redirect_hosts: pedido.redirect_uris.map((u) => new URL(u).host),
      token_endpoint_auth_method: metodo,
      ...(despejados > 0 ? { pendentes_despejados: despejados } : {}),
    },
  });

  return respostaOAuth(
    {
      client_id: clientId,
      ...(segredo ? { client_secret: segredo, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(new Date(data.created_at).getTime() / 1000),
      client_name: nome,
      redirect_uris: pedido.redirect_uris,
      token_endpoint_auth_method: metodo,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
    requestId,
  );
}
