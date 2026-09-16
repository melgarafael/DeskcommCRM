/**
 * A configuração da landing page de captura de gclid — para qual WhatsApp e
 * com qual texto pré-preenchido ela redireciona, por organização.
 *
 * Irmã de `../credenciais.ts`, e separada dela pelo mesmo motivo do
 * cabeçalho da migration 0261: esta configuração não exige a organização ter
 * conectado nada na API do Google Ads — é o eixo de CAPTURA, que nasce e
 * funciona sozinho, antes e independente do eixo de CONVERSÃO.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export interface ConfigDaLanding {
  whatsappE164: string;
  messageTemplate: string;
}

/** `null` tanto para "nunca configurou" quanto para "desligou" — a landing page trata os dois igual: não redireciona. */
export async function lerConfigDaLanding(
  admin: SupabaseClient,
  organizationId: string,
): Promise<ConfigDaLanding | null> {
  const { data, error } = await admin
    .from("google_ads_landing_pages")
    .select("whatsapp_e164, message_template, enabled")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    logger.error("[google-ads.landing-config] leitura falhou", {
      organizationId,
      detalhe: error.message,
    });
    return null;
  }
  if (!data) return null;

  const linha = data as { whatsapp_e164: string; message_template: string; enabled: boolean };
  if (!linha.enabled) return null;

  return { whatsappE164: linha.whatsapp_e164, messageTemplate: linha.message_template };
}
