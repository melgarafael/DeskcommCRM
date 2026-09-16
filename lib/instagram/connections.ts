/**
 * A conexão Instagram ativa de um lead — token decifrado + metadados.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface ConexaoDoLead {
  id: string;
  igUserId: string;
  igUsername: string | null;
  accessToken: string;
}

/**
 * `null` quando o lead nunca conectou (ou revogou) — o chamador trata como
 * "precisa conectar primeiro", nunca como erro.
 */
export async function conexaoAtivaDoLead(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<ConexaoDoLead | null> {
  const { data, error } = await admin
    .from("instagram_connections")
    .select("id, ig_user_id, ig_username, access_token_encrypted")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .is("revoked_at", null)
    .maybeSingle();

  if (error || !data) return null;

  const accessToken = await decryptWebhookSecret(
    admin,
    data.access_token_encrypted as unknown as string,
  );
  if (!accessToken) return null;

  return {
    id: data.id as string,
    igUserId: data.ig_user_id as string,
    igUsername: (data.ig_username as string | null) ?? null,
    accessToken,
  };
}
