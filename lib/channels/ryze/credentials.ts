import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface RyzeCredentials {
  instanceName: string;
  tokenInstance: string;
  baseUrl: string;
  source: "session";
}

/** A chave da busca por credenciais com isolamento tenant-aware obrigatório. */
export interface RyzeCredsLookup {
  organizationId: string;
  instanceName: string;
}

/**
 * Resolve as credenciais da instância Ryze para uma organização.
 * NUNCA busca apenas pelo instanceName (evita colisão cross-tenant).
 * Utiliza estritamente as credenciais cifradas em `channel_sessions`.
 */
export async function resolveRyzeCreds(
  db: SupabaseClient,
  lookup: RyzeCredsLookup
): Promise<RyzeCredentials | null> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("ryze_instance_name, ryze_token_encrypted")
    .eq("organization_id", lookup.organizationId)
    .eq("provider", "ryze")
    .eq("ryze_instance_name", lookup.instanceName)
    .is("archived_at", null)
    .maybeSingle();

  if (!error && data?.ryze_instance_name && data?.ryze_token_encrypted) {
    const rawCipher = data.ryze_token_encrypted;
    const cipherStr = typeof rawCipher === "string"
      ? rawCipher
      : typeof Buffer !== "undefined" && Buffer.isBuffer(rawCipher)
      ? `\\x${rawCipher.toString("hex")}`
      : String(rawCipher);

    const tokenInstance = await decryptWebhookSecret(db, cipherStr);
    if (tokenInstance) {
      const baseUrl = process.env.RYZE_API_BASE_URL || "https://ryzeapi.cloud";
      return {
        instanceName: data.ryze_instance_name,
        tokenInstance,
        baseUrl,
        source: "session",
      };
    }
  }

  return null;
}
