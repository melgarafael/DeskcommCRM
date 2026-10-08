import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { PROVEDOR } from "./constantes";

export interface IntegracaoCarregada {
  id: string;
  organizationId: string;
  status: string;
  storeId: string;
  accessToken: string;
}

/** A integração da org com o token já decifrado. null = não há com o que falar. */
export async function carregarIntegracao(admin: SupabaseClient, orgId: string): Promise<IntegracaoCarregada | null> {
  const { data, error } = await admin
    .from("tenant_integrations")
    .select("id, organization_id, status, store_metadata, oauth_access_token_encrypted")
    .eq("organization_id", orgId)
    .eq("provider", PROVEDOR)
    .maybeSingle();
  if (error) throw new Error(`integracao_leitura:${error.message}`);
  if (!data) return null;
  const linha = data as {
    id: string; organization_id: string; status: string;
    store_metadata: { store_id?: string | number } | null; oauth_access_token_encrypted: string;
  };
  const storeId = linha.store_metadata?.store_id;
  if (storeId === undefined || storeId === null || String(storeId) === "") return null;
  // bytea chega do PostgREST como "\x…"; decryptWebhookSecret normaliza e devolve null se não decifra.
  const accessToken = await decryptWebhookSecret(admin, linha.oauth_access_token_encrypted);
  if (!accessToken) return null;
  return { id: linha.id, organizationId: linha.organization_id, status: linha.status, storeId: String(storeId), accessToken };
}
