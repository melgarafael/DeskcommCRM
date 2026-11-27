/**
 * O aplicativo OAuth da Microsoft desta INSTALAÇÃO.
 *
 * Só a tela cadastra (`/admin/microsoft`): sem linha no banco a integração não
 * existe e nada dela aparece na Agenda. Cada pessoa depois conecta a PRÓPRIA
 * conta; o aplicativo só identifica a instalação.
 *
 * Nunca lança: é chamado no render da Agenda, e um throw ali é 500 na tela.
 */
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

/** Tem de estar registrado no portal da Microsoft, byte a byte. */
export const CAMINHO_DO_CALLBACK_DA_MICROSOFT = "/api/v1/agenda/microsoft/callback";

/** `common` aceita conta de empresa e conta pessoal. */
export const DIRETORIO_PADRAO = "common";

/** O id do diretório (GUID), um domínio, ou um dos três nomes da plataforma. */
export const FORMATO_DO_DIRETORIO =
  /^(common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9-]+(\.[a-z0-9-]+)+)$/i;

export interface AppDaMicrosoft {
  clientId: string;
  clientSecret: string;
  tenant: string;
  redirectUri: string;
}

export function enderecoDeRetornoDaMicrosoft(urlDaAplicacao: string = env.NEXT_PUBLIC_APP_URL): string {
  return `${urlDaAplicacao.trim().replace(/\/+$/, "")}${CAMINHO_DO_CALLBACK_DA_MICROSOFT}`;
}

export async function configuracaoDaMicrosoft(urlDaAplicacao?: string): Promise<AppDaMicrosoft | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("platform_microsoft_oauth")
      .select("client_id, client_secret_encrypted, tenant")
      .eq("id", 1)
      // Fora da deduplicação de `fetch` do Next dentro de um render (#1218).
      .abortSignal(new AbortController().signal)
      .maybeSingle();
    if (error || !data) return null;
    const linha = data as {
      client_id: string | null;
      client_secret_encrypted: string | null;
      tenant: string | null;
    };
    const clientId = linha.client_id?.trim();
    if (!clientId || !linha.client_secret_encrypted) return null;
    const clientSecret = await decryptWebhookSecret(admin, linha.client_secret_encrypted);
    if (!clientSecret) {
      logger.warn("[agenda.microsoft.config] o segredo gravado não decifrou");
      return null;
    }
    const tenant = linha.tenant?.trim() || DIRETORIO_PADRAO;
    return {
      clientId,
      clientSecret,
      tenant: FORMATO_DO_DIRETORIO.test(tenant) ? tenant : DIRETORIO_PADRAO,
      redirectUri: enderecoDeRetornoDaMicrosoft(urlDaAplicacao),
    };
  } catch (err) {
    logger.warn("[agenda.microsoft.config] leitura falhou", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function microsoftEstaConfigurada(): Promise<boolean> {
  return (await configuracaoDaMicrosoft()) !== null;
}
