/**
 * Canal de SMS (#4415) — a credencial gravada na conexão.
 *
 * A chave da conta mora cifrada em `channel_sessions.webhook_secret_encrypted`:
 * no fornecedor de SMS, quem assina cada webhook é a própria chave da conta,
 * então ela É o segredo do webhook desta conexão (migration 9345). Uma coluna
 * só, uma fonte só — trocar a chave é reconectar, e a troca vale para o envio
 * e para a conferência do webhook ao mesmo tempo. Só existe decifrada dentro
 * do processo, pelo tempo de um envio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import type { SmsCredentials } from "./twilio";

/** Como a conexão aparece na tela. Nome de marca, igual em todo idioma. */
export const ROTULO_DO_CANAL_SMS = "SMS";

export interface SmsConexao extends SmsCredentials {
  channelSessionId: string;
  /** Id do número no fornecedor (`PN…`) — o sessionRef. */
  numeroId: string;
  /** O número da empresa, E.164 com `+`. É o remetente de todo envio. */
  numero: string;
}

/**
 * A conexão ativa de SMS desta organização com este número, já com a chave
 * decifrada — ou `null` quando não há (não conectada, arquivada, ou a cifra
 * indisponível porque a GUC da instalação não está posta).
 *
 * Filtra `organization_id` explicitamente: o admin client ignora RLS, e o
 * `sessionRef` sozinho não é fonte confiável de tenant.
 */
export async function conexaoDeSms(
  admin: SupabaseClient,
  lookup: { organizationId: string; numeroId: string },
): Promise<SmsConexao | null> {
  const { organizationId, numeroId } = lookup;
  if (!organizationId || !numeroId) return null;

  const base = () =>
    admin
      .from("channel_sessions")
      .select("id, phone_number, twilio_phone_number_sid, twilio_account_sid, webhook_secret_encrypted")
      .eq("organization_id", organizationId)
      .eq("twilio_phone_number_sid", numeroId);

  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (error) {
    throw new Error(`sms_creds_lookup_failed: ${error.code ?? "sem_codigo"} ${error.message ?? ""}`.trim());
  }

  const linha = data as {
    id: string;
    phone_number: string | null;
    twilio_phone_number_sid: string;
    twilio_account_sid: string | null;
    webhook_secret_encrypted: unknown;
  } | null;
  if (!linha || !linha.webhook_secret_encrypted || !linha.twilio_account_sid || !linha.phone_number) {
    return null;
  }

  const authToken = await decryptWebhookSecret(admin, linha.webhook_secret_encrypted as string);
  if (!authToken) return null;

  return {
    channelSessionId: linha.id,
    numeroId: linha.twilio_phone_number_sid,
    numero: linha.phone_number.startsWith("+") ? linha.phone_number : `+${linha.phone_number}`,
    accountSid: linha.twilio_account_sid,
    authToken,
  };
}
