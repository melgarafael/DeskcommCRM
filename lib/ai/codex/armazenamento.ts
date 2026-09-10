/**
 * Cofre do vínculo OAuth Codex — persistência cifrada, sem protocolo.
 *
 * O refresh token é cifrado com AES-256-GCM (`lib/crypto/aes_gcm`, as mesmas
 * colunas de `ai_provider_credentials`) e o filtro `organization_id` é sempre
 * programático: o admin client bypassa RLS (doutrina, anti-pattern 10). Nenhum
 * plaintext atravessa log ou resposta — vive no escopo da chamada.
 */
import { bufToBytea, byteaToBuffer, decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";
import type { createAdminClient } from "@/lib/supabase/admin";

export async function salvarVinculo(p: {
  admin: ReturnType<typeof createAdminClient>;
  orgId: string;
  userId: string;
  label: string;
  refreshToken: string;
}): Promise<{ id: string }> {
  const enc = encryptKey(p.refreshToken);
  const { data, error } = await p.admin
    .from("ai_provider_oauth")
    .upsert(
      {
        organization_id: p.orgId,
        provider: "openai-codex",
        label: p.label.slice(0, 80),
        refresh_encrypted: bufToBytea(enc.ciphertext),
        refresh_iv: bufToBytea(enc.iv),
        refresh_tag: bufToBytea(enc.tag),
        status: "active",
        quarantined_reason: null,
        created_by: p.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,provider" },
    )
    .select("id")
    .single();
  if (error || !data) throw new Error(`codex_vinculo_banco: ${error?.message ?? "sem id"}`);
  return { id: (data as { id: string }).id };
}

export async function lerRefreshToken(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
): Promise<{ id: string; refreshToken: string } | null> {
  const { data } = await admin
    .from("ai_provider_oauth")
    .select("id, refresh_encrypted, refresh_iv, refresh_tag")
    .eq("organization_id", orgId)
    .eq("provider", "openai-codex")
    .eq("status", "active")
    .maybeSingle();
  if (!data) return null;
  const row = data as { id: string; refresh_encrypted: unknown; refresh_iv: unknown; refresh_tag: unknown };
  const refreshToken = decryptKey({
    ciphertext: byteaToBuffer(row.refresh_encrypted),
    iv: byteaToBuffer(row.refresh_iv),
    tag: byteaToBuffer(row.refresh_tag),
  });
  return { id: row.id, refreshToken };
}

export async function quarentenarVinculo(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  motivo: string,
): Promise<void> {
  await admin
    .from("ai_provider_oauth")
    .update({ status: "quarantined", quarantined_reason: motivo.slice(0, 300), updated_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("provider", "openai-codex");
}

export async function revogarVinculo(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
): Promise<void> {
  await admin
    .from("ai_provider_oauth")
    .update({ status: "revoked", quarantined_reason: null, updated_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("provider", "openai-codex");
}
