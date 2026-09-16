/**
 * O Meta App da organização — App ID + Secret decifrado.
 *
 * Um por organização (`instagram_apps`, migration 0264, unique em
 * `organization_id`). Mesma cifra do resto do repo (`fn_encrypt_oauth`/
 * `fn_decrypt_oauth`, ver `lib/webhooks/secrets.ts`) — nunca um terceiro
 * caminho.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";

export interface InstagramApp {
  appId: string;
  appSecret: string;
  /** `null` = sem restrição. Populado = lista de teste (mesmo desenho do pré-go-live do WhatsApp). */
  allowedPhoneNumbers: string[] | null;
}

/**
 * `null` quando a organização não cadastrou um App ainda, ou quando a
 * decifra falhou (chave mestra ausente na instalação) — o chamador trata os
 * dois casos como "Instagram não configurado", nunca como erro 500: uma
 * rota pública alcançável por um lead não pode vazar stack de servidor.
 */
export async function instagramAppDaOrganizacao(
  admin: SupabaseClient,
  organizationId: string,
): Promise<InstagramApp | null> {
  const { data, error } = await admin
    .from("instagram_apps")
    .select("app_id, app_secret_encrypted, allowed_phone_numbers")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .maybeSingle();

  if (error || !data || !data.app_secret_encrypted) return null;

  const appSecret = await decryptWebhookSecret(
    admin,
    data.app_secret_encrypted as unknown as string,
  );
  if (!appSecret) return null;

  return {
    appId: data.app_id as string,
    appSecret,
    allowedPhoneNumbers: (data.allowed_phone_numbers as string[] | null) ?? null,
  };
}

/**
 * `true` quando a organização não tem lista de teste (sem restrição) OU
 * quando o telefone está nela. Cobre as variantes do nono dígito do Brasil
 * pela mesma comparação do pré-go-live do WhatsApp — sem isso, `+5513...`
 * gravado sem o 9 não bateria com o número que chega com ele.
 */
export function numeroAutorizadoAPublicar(
  app: Pick<InstagramApp, "allowedPhoneNumbers">,
  telefoneDoContato: string | null | undefined,
): boolean {
  if (!app.allowedPhoneNumbers || app.allowedPhoneNumbers.length === 0) return true;
  if (!telefoneDoContato) return false;
  const variantesDoContato = new Set(phoneLookupVariants(telefoneDoContato));
  if (variantesDoContato.size === 0) return false;
  return app.allowedPhoneNumbers.some((numero) =>
    phoneLookupVariants(numero).some((variante) => variantesDoContato.has(variante)),
  );
}
