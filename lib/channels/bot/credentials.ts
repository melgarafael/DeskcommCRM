/**
 * Credencial do bot do Telegram — **por sessão**, como os demais canais.
 *
 * O token do @BotFather vive cifrado em `channel_sessions.telegram_token_encrypted`
 * (migration 0810), pelas MESMAS RPCs de cifra do resto do repo
 * (`fn_encrypt_oauth`/`fn_decrypt_oauth`, ver `lib/webhooks/secrets.ts`). Não há
 * fallback por variável de ambiente: diferente do canal oficial, aqui o token é
 * a IDENTIDADE do bot — um `.env` compartilhado faria toda organização falar
 * pelo mesmo robô, que é exatamente o defeito que a issue #236 pagou caro para
 * descobrir num canal vizinho.
 *
 * A busca leva a ORGANIZAÇÃO junto e LANÇA quando a consulta falha, pelo motivo
 * escrito em `../meta/credentials.ts`: com o client de service role não há RLS
 * segurando nada, e um `null` por erro de leitura viraria "canal não
 * configurado" em cima de um canal que existe.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { TELEGRAM_API_BASE } from "./webhook";

export interface TelegramCredentials {
  /** `channel_sessions.telegram_bot_id` — o `sessionRef` deste canal. */
  botId: string;
  token: string;
}

export interface TelegramCredsLookup {
  organizationId: string;
  botId: string;
}

/**
 * A URL de um método da Bot API.
 *
 * O token vai no CAMINHO (`/bot<token>/<método>`), que é o desenho da
 * plataforma. Por isso esta função mora aqui e não numa feature: montar a URL
 * fora daqui espalharia o segredo por call sites que ninguém revisa.
 */
export function telegramApiUrl(token: string, method: string): string {
  return `${TELEGRAM_API_BASE}/bot${token}/${method}`;
}

/** Resposta crua da Bot API: `{ ok, result }` ou `{ ok: false, description, error_code }`. */
interface TelegramEnvelope<T> {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/**
 * Chama um método da Bot API e devolve o `result`.
 *
 * LANÇA com o código e a descrição da plataforma quando ela recusa. O
 * `description` do Telegram é o único lugar que distingue "chat não encontrado"
 * de "bot bloqueado pelo usuário" de "token revogado", e sem ele o operador lê
 * "falhou". O TOKEN nunca entra na mensagem de erro: ela é gravada em
 * `messages.error_message` e em log.
 */
export async function telegramRequest<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(telegramApiUrl(token, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    // Teto de espera: um provedor que pendura a conexão pendura o envio e o
    // turno do agente junto.
    signal: AbortSignal.timeout(20_000),
  });

  const json = (await res.json().catch(() => null)) as TelegramEnvelope<T> | null;

  if (!res.ok || !json?.ok) {
    const codigo = json?.error_code ?? res.status;
    const motivo = json?.description ?? res.statusText;
    const espera = json?.parameters?.retry_after;
    throw new Error(
      `telegram_${method.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}_failed: ${codigo} ${motivo}` +
        (espera ? ` (retry_after=${espera}s)` : ""),
    );
  }

  return json.result as T;
}

/**
 * O token gravado nesta sessão, ou `null` quando não há (canal ainda não
 * conectado, ou cifra indisponível porque a GUC da instalação não está posta).
 */
export async function telegramCredsForBotId(
  admin: SupabaseClient,
  lookup: TelegramCredsLookup,
): Promise<TelegramCredentials | null> {
  const { organizationId, botId } = lookup;
  if (!organizationId || !botId) return null;

  const base = () =>
    admin
      .from("channel_sessions")
      .select("telegram_bot_id, telegram_token_encrypted")
      .eq("organization_id", organizationId)
      .eq("telegram_bot_id", botId);

  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (error) {
    throw new Error(
      `telegram_creds_lookup_failed: ${error.code ?? "sem_codigo"} ${error.message ?? ""}`.trim(),
    );
  }

  const cifrado = (data as { telegram_token_encrypted?: unknown } | null)?.telegram_token_encrypted;
  if (!data || !cifrado) return null;

  const token = await decryptWebhookSecret(admin, cifrado as string);
  if (!token) return null;

  return { botId: (data as { telegram_bot_id: string }).telegram_bot_id, token };
}

/** O `getMe` do bot: prova que o token presta e devolve a identidade dele. */
export interface TelegramBotInfo {
  id: string;
  username: string | null;
  firstName: string | null;
  /** `true` quando o bot aceita entrar em grupo — a v1 não usa, mas a tela informa. */
  canJoinGroups: boolean;
}

/**
 * Confere o token com `getMe` ANTES de gravar — mesma decisão da conexão
 * oficial: gravar primeiro e descobrir depois é o que faz o operador achar que
 * conectou e só entender que não na primeira mensagem que não sai.
 */
export async function telegramGetMe(token: string): Promise<TelegramBotInfo> {
  const me = await telegramRequest<{
    id?: number;
    username?: string;
    first_name?: string;
    can_join_groups?: boolean;
  }>(token, "getMe");
  if (typeof me?.id !== "number") {
    throw new Error("telegram_get_me_invalid: resposta sem id do bot");
  }
  return {
    id: String(me.id),
    username: me.username ?? null,
    firstName: me.first_name ?? null,
    canJoinGroups: me.can_join_groups === true,
  };
}
