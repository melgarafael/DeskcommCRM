/**
 * Canal de SMS (#4415) — o que a desconexão desfaz no fornecedor e no banco.
 *
 * Chamado pela rota de exclusão de conexão (app/api/v1/channel-sessions/[id])
 * ANTES do patch que arquiva a linha, porque é a chave gravada nela que
 * autoriza a chamada ao fornecedor. Best-effort como os outros canais: o
 * fornecedor fora do ar vai para o log e para a auditoria, e não desfaz a
 * exclusão que o operador pediu.
 *
 * Devolve também um segredo NOVO, cifrado, para a rota gravar no lugar da
 * chave: no SMS o segredo do webhook É a chave da conta, e ela não pode ficar
 * guardada numa conexão desligada (o canal oficial zera o token pelo mesmo
 * motivo). A coluna é NOT NULL, então o lugar dela fica com lixo aleatório.
 */
import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

import { limparRecebimentoDoNumero } from "./twilio";

export interface EncerramentoDoSms {
  recebimento: "desfeito" | "sem_credencial" | "falhou";
  /** Segredo aleatório já cifrado, ou null quando a cifra não está disponível. */
  segredoNovoCifrado: string | null;
}

export async function encerrarConexaoDeSms(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<EncerramentoDoSms> {
  const segredoNovoCifrado = await encryptWebhookSecret(admin, randomBytes(32).toString("hex"));

  const { data } = await admin
    .from("channel_sessions")
    .select("twilio_phone_number_sid, twilio_account_sid, webhook_secret_encrypted")
    .eq("organization_id", input.organizationId)
    .eq("id", input.channelSessionId)
    .maybeSingle();
  const linha = data as {
    twilio_phone_number_sid: string | null;
    twilio_account_sid: string | null;
    webhook_secret_encrypted: unknown;
  } | null;
  if (!linha?.twilio_phone_number_sid || !linha.twilio_account_sid || !linha.webhook_secret_encrypted) {
    return { recebimento: "sem_credencial", segredoNovoCifrado };
  }

  const chave = await decryptWebhookSecret(admin, linha.webhook_secret_encrypted as string);
  if (!chave) return { recebimento: "sem_credencial", segredoNovoCifrado };

  const r = await limparRecebimentoDoNumero(
    { accountSid: linha.twilio_account_sid, authToken: chave },
    linha.twilio_phone_number_sid,
    fetchImpl,
  );
  return { recebimento: r.ok ? "desfeito" : "falhou", segredoNovoCifrado };
}
