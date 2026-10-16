import { type NextRequest, NextResponse } from "next/server";

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { trocarCodeOAuthPorToken } from "@/lib/integrations/bling/client";
import { verificarEstadoBling } from "@/lib/integrations/bling/state";
import { registrarLogBling, salvarCredenciaisBling } from "@/lib/integrations/bling/store";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  const baseUrl = url.origin;

  if (errorParam) {
    logger.warn("[bling.callback] Bling retornou erro na autorização", {
      error: errorParam,
      description: errorDescription,
    });
    return NextResponse.redirect(new URL("/app/settings/bling?error=denied", baseUrl));
  }

  const estado = verificarEstadoBling(stateParam);
  if (!estado) {
    logger.warn("[bling.callback] Estado OAuth inválido ou expirado", { state: stateParam });
    return NextResponse.redirect(new URL("/app/settings/bling?error=invalid_state", baseUrl));
  }

  if (!code) {
    return NextResponse.redirect(new URL("/app/settings/bling?error=missing_code", baseUrl));
  }

  const admin = createAdminClient();
  const orgId = estado.organizationId;

  // Busca dados atuais da integração para obter client_id e client_secret
  const { data: integracao, error: erroIntegracao } = await admin
    .from("bling_integrations")
    .select("client_id, client_secret_encrypted")
    .eq("organization_id", orgId)
    .maybeSingle();

  if (erroIntegracao || !integracao || !integracao.client_id || !integracao.client_secret_encrypted) {
    logger.error("[bling.callback] Credenciais prévias do Bling não localizadas", { orgId });
    return NextResponse.redirect(new URL("/app/settings/bling?error=credentials_not_found", baseUrl));
  }

  const clientSecret = await decryptWebhookSecret(admin, integracao.client_secret_encrypted);
  if (!clientSecret) {
    logger.error("[bling.callback] Falha ao descriptografar client_secret", { orgId });
    return NextResponse.redirect(new URL("/app/settings/bling?error=crypto_failed", baseUrl));
  }

  const redirectUri = `${baseUrl}/api/v1/integrations/bling/callback`;

  // Troca o código pelo access_token e refresh_token
  const resultadoTroca = await trocarCodeOAuthPorToken(
    integracao.client_id,
    clientSecret,
    code,
    redirectUri
  );

  if (!resultadoTroca.ok || !resultadoTroca.tokens) {
    logger.error("[bling.callback] Falha ao trocar authorization_code por tokens no Bling", {
      error: resultadoTroca.error,
    });
    await registrarLogBling(admin, orgId, {
      operation: "oauth_callback_token_exchange",
      direction: "outbound",
      status: "failed",
      details: { error: resultadoTroca.error },
      error_message: resultadoTroca.error ?? "Falha na troca de código por token",
    });
    return NextResponse.redirect(new URL("/app/settings/bling?error=token_exchange_failed", baseUrl));
  }

  const tokens = resultadoTroca.tokens;

  // Salva tokens no banco
  const resultadoSalvar = await salvarCredenciaisBling(admin, orgId, {
    clientId: integracao.client_id,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
  });

  if (!resultadoSalvar.ok) {
    logger.error("[bling.callback] Falha ao salvar tokens no banco", { error: resultadoSalvar.error });
    return NextResponse.redirect(new URL("/app/settings/bling?error=save_failed", baseUrl));
  }

  // Ativa a integração por padrão ao autorizar
  await admin
    .from("bling_integrations")
    .update({ is_enabled: true })
    .eq("organization_id", orgId);

  await registrarLogBling(admin, orgId, {
    operation: "oauth_connected",
    direction: "outbound",
    status: "success",
    details: {
      scope: tokens.scope,
      expires_in: tokens.expires_in,
    },
    error_message: null,
  });

  audit({
    action: "bling.connected",
    actorUserId: estado.userId,
    organizationId: orgId,
    resourceType: "bling_integration",
    resourceId: orgId,
    metadata: { scope: tokens.scope },
  });

  return NextResponse.redirect(new URL("/app/settings/bling?connected=true", baseUrl));
}
