/**
 * Cifra/decifra de secrets de webhooks (at-rest) — retrofit da spec §10.
 *
 * Reusa a infra do Nuvemshop/WAHA: RPCs `fn_encrypt_oauth`/`fn_decrypt_oauth`
 * (pgp_sym AES-256 com a chave na GUC `app.nuvemshop_oauth_key`). As RPCs têm
 * GRANT apenas para service_role — sempre chame com o admin client.
 *
 * Contrato de erro: encrypt SEM chave configurada retorna null (o caller
 * decide — rotas de escrita respondem 422 com instrução); decrypt que falha
 * retorna null (o caller aplica o precedente WAHA: hmacSkipped, nunca 500).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";

/** Cifra um secret. Retorna o bytea (formato hex "\x…" do PostgREST) ou null se a chave estiver ausente/erro. */
export async function encryptWebhookSecret(
  admin: SupabaseClient,
  plaintext: string,
): Promise<string | null> {
  const { data, error } = await admin.rpc("fn_encrypt_oauth", { plaintext });
  if (error || !data) {
    logger.warn("[webhooks.secrets] encrypt falhou (GUC app.nuvemshop_oauth_key ausente?)", {
      error: error?.message ?? "empty",
    });
    return null;
  }
  return data as string;
}

/** Decifra um secret cifrado (bytea hex ou hex puro de jsonb). null em falha. */
export async function decryptWebhookSecret(
  admin: SupabaseClient,
  ciphertext: string,
): Promise<string | null> {
  const normalized = ciphertext.startsWith("\\x") ? ciphertext : `\\x${ciphertext}`;
  const { data, error } = await admin.rpc("fn_decrypt_oauth", { ciphertext: normalized });
  if (error || !data) return null;
  return data as string;
}

export interface RuleActionInput {
  type: string;
  config?: Record<string, unknown>;
}

/**
 * Troca `config.secret` (plaintext, input do editor) por `config.secret_enc`
 * (hex cifrado) em ações call_webhook antes de gravar no jsonb da regra.
 * `secret_enc` já presente (round-trip do editor sem re-digitar) passa direto.
 * Retorna null se a cifra estiver indisponível (caller responde 422).
 */
export async function encryptRuleActionSecrets(
  admin: SupabaseClient,
  actions: RuleActionInput[],
): Promise<RuleActionInput[] | null> {
  const out: RuleActionInput[] = [];
  for (const action of actions) {
    if (action.type === "call_webhook" && typeof action.config?.secret === "string" && action.config.secret) {
      const enc = await encryptWebhookSecret(admin, action.config.secret);
      if (enc === null) return null;
      const { secret: _plain, ...restConfig } = action.config;
      out.push({ ...action, config: { ...restConfig, secret_enc: enc.replace(/^\\x/, "") } });
    } else {
      const { secret: _drop, ...restConfig } = action.config ?? {};
      out.push({ ...action, config: restConfig });
    }
  }
  return out;
}
