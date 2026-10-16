import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import {
  type BlingFeatures,
  type BlingIntegrationConfig,
  type BlingSyncLog,
  DEFAULT_BLING_FEATURES,
} from "./types";
import { BlingClient, renovarTokenOAuth } from "./client";
import { logger } from "@/lib/logger";

export async function obterConfiguracaoBling(
  admin: SupabaseClient,
  orgId: string
): Promise<BlingIntegrationConfig | null> {
  const { data, error } = await admin
    .from("bling_integrations")
    .select("id, organization_id, is_enabled, client_id, status, features, last_synced_at, created_at, updated_at")
    .eq("organization_id", orgId)
    .maybeSingle();

  if (error || !data) return null;

  return {
    ...data,
    features: {
      ...DEFAULT_BLING_FEATURES,
      ...(data.features as Record<string, boolean>),
    },
  } as BlingIntegrationConfig;
}

export async function obterClienteBlingAutenticado(
  admin: SupabaseClient,
  orgId: string
): Promise<{ client?: BlingClient; error?: string }> {
  const { data, error } = await admin
    .from("bling_integrations")
    .select("*")
    .eq("organization_id", orgId)
    .maybeSingle();

  if (error || !data || !data.is_enabled) {
    return { error: "Integração com o Bling não está ativa para esta empresa" };
  }

  if (!data.access_token_encrypted) {
    return { error: "Credenciais do Bling não configuradas" };
  }

  let accessToken = await decryptWebhookSecret(admin, data.access_token_encrypted);

  // Verifica se o token expirou e precisamos renovar com refresh_token
  const agora = new Date();
  const tokenExpiresAt = data.token_expires_at ? new Date(data.token_expires_at) : null;

  if (tokenExpiresAt && tokenExpiresAt.getTime() - agora.getTime() < 5 * 60 * 1000) {
    // Falta menos de 5 minutos para expirar ou já expirou: renovar!
    if (data.client_id && data.client_secret_encrypted && data.refresh_token_encrypted) {
      const clientSecret = await decryptWebhookSecret(admin, data.client_secret_encrypted);
      const refreshToken = await decryptWebhookSecret(admin, data.refresh_token_encrypted);

      if (clientSecret && refreshToken) {
        const renovacao = await renovarTokenOAuth(data.client_id, clientSecret, refreshToken);
        if (renovacao.ok && renovacao.tokens) {
          const novoAccessEnc = await encryptWebhookSecret(admin, renovacao.tokens.access_token);
          const novoRefreshEnc = await encryptWebhookSecret(admin, renovacao.tokens.refresh_token);
          const novoExpiresAt = new Date(Date.now() + renovacao.tokens.expires_in * 1000).toISOString();

          await admin
            .from("bling_integrations")
            .update({
              access_token_encrypted: novoAccessEnc,
              refresh_token_encrypted: novoRefreshEnc,
              token_expires_at: novoExpiresAt,
              status: "connected",
              updated_at: new Date().toISOString(),
            })
            .eq("organization_id", orgId);

          accessToken = renovacao.tokens.access_token;
        } else {
          logger.warn("[bling.store] Falha ao renovar token OAuth", { error: renovacao.error });
        }
      }
    }
  }

  if (!accessToken) {
    return { error: "Não foi possível descriptografar o token do Bling" };
  }

  return { client: new BlingClient(accessToken) };
}

export async function salvarCredenciaisBling(
  admin: SupabaseClient,
  orgId: string,
  input: {
    clientId: string;
    clientSecret?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
  }
): Promise<{ ok: boolean; error?: string }> {
  let clientSecretEnc: string | null = null;
  let accessTokenEnc: string | null = null;
  let refreshTokenEnc: string | null = null;
  let tokenExpiresAt: string | null = null;

  if (input.clientSecret) {
    clientSecretEnc = await encryptWebhookSecret(admin, input.clientSecret);
  }
  if (input.accessToken) {
    accessTokenEnc = await encryptWebhookSecret(admin, input.accessToken);
  }
  if (input.refreshToken) {
    refreshTokenEnc = await encryptWebhookSecret(admin, input.refreshToken);
  }
  if (input.expiresIn) {
    tokenExpiresAt = new Date(Date.now() + input.expiresIn * 1000).toISOString();
  }

  const payload: Record<string, any> = {
    organization_id: orgId,
    client_id: input.clientId,
    status: input.accessToken ? "connected" : "disconnected",
    updated_at: new Date().toISOString(),
  };

  if (clientSecretEnc) payload.client_secret_encrypted = clientSecretEnc;
  if (accessTokenEnc) payload.access_token_encrypted = accessTokenEnc;
  if (refreshTokenEnc) payload.refresh_token_encrypted = refreshTokenEnc;
  if (tokenExpiresAt) payload.token_expires_at = tokenExpiresAt;

  const { error } = await admin
    .from("bling_integrations")
    .upsert(payload, { onConflict: "organization_id" });

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true };
}

export async function atualizarFeaturesBling(
  admin: SupabaseClient,
  orgId: string,
  input: {
    is_enabled?: boolean;
    features?: Partial<BlingFeatures>;
  }
): Promise<{ ok: boolean; error?: string }> {
  const atual = await obterConfiguracaoBling(admin, orgId);

  const payload: Record<string, any> = {
    updated_at: new Date().toISOString(),
  };

  if (input.is_enabled !== undefined) {
    payload.is_enabled = input.is_enabled;
  }

  if (input.features) {
    const featuresAtuais = atual?.features ?? DEFAULT_BLING_FEATURES;
    payload.features = {
      ...featuresAtuais,
      ...input.features,
    };
  }

  const { error } = await admin
    .from("bling_integrations")
    .update(payload)
    .eq("organization_id", orgId);

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true };
}

export async function desconectarBling(
  admin: SupabaseClient,
  orgId: string
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await admin
    .from("bling_integrations")
    .update({
      is_enabled: false,
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      token_expires_at: null,
      status: "disconnected",
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", orgId);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function registrarLogBling(
  admin: SupabaseClient,
  orgId: string,
  log: Omit<BlingSyncLog, "id" | "organization_id" | "created_at">
): Promise<void> {
  try {
    await admin.from("bling_sync_logs").insert({
      organization_id: orgId,
      operation: log.operation,
      direction: log.direction,
      status: log.status,
      details: log.details ?? {},
      error_message: log.error_message ?? null,
    });
  } catch (err: any) {
    logger.warn("[bling.store] Falha ao registrar log de sincronização", { error: err?.message });
  }
}

export async function buscarLogsRecentesBling(
  admin: SupabaseClient,
  orgId: string,
  limit = 20
): Promise<BlingSyncLog[]> {
  const { data, error } = await admin
    .from("bling_sync_logs")
    .select("*")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data as BlingSyncLog[];
}
