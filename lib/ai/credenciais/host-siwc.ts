import { CHAVE_DO_HOST_SIWC, novoHostIdSiwc } from "@/lib/ai/pontos/pkce-da-assinatura";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * SIWC identifies the VPS separately from an OAuth client/account. Keep one
 * opaque host id in the installation-wide table so every tenant on this VPS
 * reuses it across sign-ins and restarts.
 */
export async function lerOuCriarHostIdSiwc(admin: Admin): Promise<string | null> {
  const { data: existente } = await admin
    .from("platform_config")
    .select("valor")
    .eq("chave", CHAVE_DO_HOST_SIWC)
    .maybeSingle();
  if (typeof existente?.valor === "string" && /^urn:uuid:[0-9a-f-]{36}$/i.test(existente.valor)) {
    return existente.valor;
  }

  const hostId = novoHostIdSiwc();
  const { error } = await admin.from("platform_config").insert({
    chave: CHAVE_DO_HOST_SIWC,
    valor: hostId,
    eh_segredo: false,
    semeado_do_env: false,
  });
  if (!error) return hostId;

  // A unique-key race is harmless: read the winner. Any other failure fails
  // closed, since an ephemeral host id would split one VPS into fake hosts.
  const { data: vencedor } = await admin
    .from("platform_config")
    .select("valor")
    .eq("chave", CHAVE_DO_HOST_SIWC)
    .maybeSingle();
  return typeof vencedor?.valor === "string" && /^urn:uuid:[0-9a-f-]{36}$/i.test(vencedor.valor)
    ? vencedor.valor
    : null;
}
