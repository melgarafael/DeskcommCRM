/**
 * A credencial do canal OLX — uma leitura, um lugar (#2927).
 *
 * O que a conta de anunciante precisa ter para o canal funcionar é UMA coisa:
 * o access token com o escopo `chat`, que a OLX emite por OAuth
 * (`https://auth.olx.com.br/oauth`, doc `developers.olx.com.br/chat/oauth_chat.html`).
 * Ele autentica os TRÊS endpoints do canal — registrar o webhook, enviar
 * mensagem e desligar — sempre no header `Authorization: Bearer`, nunca em
 * query string.
 *
 * ─── Por que o token mora cifrado na SESSÃO ────────────────────────────────
 *
 * Pelo mesmo desenho do Datafy: `fn_encrypt_oauth` grava, `fn_decrypt_oauth`
 * devolve, e a coluna nunca volta à tela depois de gravada. Um token em
 * variável de ambiente seria UM por instalação; a OLX emite um por conta de
 * anunciante, e duas contas na mesma instalação passariam a compartilhar
 * credencial — que é exatamente o defeito #236 de outra forma.
 *
 * ─── O que NÃO está aqui ───────────────────────────────────────────────────
 *
 * O fluxo de autorização (redirect, `code` de 10 minutos, troca por token).
 * Ele depende de `client_id`/`client_secret` que só existem depois do cadastro
 * do integrador junto à OLX (`suporteintegrador@olxbr.com`, doc
 * `anuncio/api/oauth.html`), e não há credencial neste repositório. Enquanto
 * não houver, `send` desiste com `olx_not_configured` e a tela de conexão não
 * é oferecida — inventar o fluxo seria pior que declará-lo ausente.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface CredenciaisOlx {
  channelSessionId: string;
  /** `channel_sessions.olx_account_id` — o sessionRef deste canal. */
  conta: string;
  token: string;
}

/**
 * `null` quando a sessão não existe, está arquivada ou não tem token gravado.
 * Quem chama NUNCA trata `null` como "canal desligado": é "não tenho com o que
 * falar", e o desfecho disso é `olx_not_configured` no envio, não um silêncio.
 */
export async function resolverCredenciaisOlx(
  admin: SupabaseClient,
  lookup: { organizationId: string; conta: string },
): Promise<CredenciaisOlx | null> {
  const { organizationId, conta } = lookup;
  if (!organizationId || !conta) return null;

  const base = () =>
    admin
      .from("channel_sessions")
      .select(`id, olx_account_id, olx_token_encrypted, ${ARCHIVED_AT}`)
      .eq("organization_id", organizationId)
      .eq("olx_account_id", conta);

  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (error) {
    throw new Error(
      `olx_creds_lookup_failed: ${error.code ?? "sem_codigo"} ${error.message ?? ""}`.trim(),
    );
  }

  const linha = data as {
    id: string;
    olx_account_id: string;
    olx_token_encrypted?: unknown;
  } | null;
  if (!linha?.olx_token_encrypted) return null;

  const token = await decryptWebhookSecret(admin, linha.olx_token_encrypted as string);
  if (!token) return null;

  return { channelSessionId: linha.id, conta: linha.olx_account_id, token };
}
