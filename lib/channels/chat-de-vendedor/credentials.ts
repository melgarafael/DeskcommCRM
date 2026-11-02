/**
 * Canal do chat de vendedor da OLX (issue #2927) — o interruptor da instalação
 * e a credencial POR SESSÃO.
 *
 * ─── Por que os nomes deste diretório não citam o provider ──────────────────
 *
 * `lib/channels/` pode nomear o provider (a exceção do `lint:channels`), mas
 * quem é importado DE FORA daqui não: a rota de conexão mora em `app/`, e o
 * invariante 1 da doutrina (`docs/doctrine/restricao-de-canal.md`) reprova um
 * `app/**` que escreva `olx` — inclusive no caminho do import. É o mesmo corte
 * do canal parceiro que espelha a Cloud API (`lib/channels/graph-parceiro/`):
 * o seam nomeia, a feature outside fala em "o canal", "o token", "o vendedor".
 *
 * ─── Desligado por padrão (molde do #1459, decisão do mantidor) ─────────────
 *
 * Canal opcional da INSTALAÇÃO, como o Datafy: sem `OLX_ENABLED=true` no
 * `.env`, quem instala não vê rota de conexão (404), o webhook não aceita
 * entrega e o envio desiste com `olx_not_configured`. Quem não liga não vê
 * nada, e o schema que a fatia 1 criou deixa de ser um canal que existe no
 * banco e não funciona — é um canal que existe e está desligado.
 *
 * ─── Sem credencial de ambiente ─────────────────────────────────────────────
 *
 * O access token é POR ORGANIZAÇÃO, cifrado na linha da sessão
 * (`channel_sessions.olx_token_encrypted`), colado pela rota de conexão. Uma
 * credencial de `.env` serviria a qualquer organização cuja sessão não tivesse
 * token — o defeito que a issue #236 mediu no canal oficial.
 *
 * A busca leva a ORGANIZAÇÃO junto (issue #236): `olx_seller_id` é
 * identificador do PROVIDER, e duas linhas com o mesmo valor fariam
 * `maybeSingle()` devolver `PGRST116`. A cifra é a mesma dos demais parceiros
 * (`fn_encrypt_oauth` via `lib/webhooks/secrets.ts`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";

/**
 * A instalação liga este canal?
 *
 * Só `true` literal liga (sem diferenciar caixa, com `trim`): um `.env`
 * escrito à mão com `1`, `sim` ou espaço sobrando não pode ligar o canal por
 * acidente. O parâmetro existe para o teste; em produção o padrão lê o
 * ambiente.
 */
export function canalChatDeVendedorLigado(
  valor: string | undefined = process.env.OLX_ENABLED,
): boolean {
  return (valor ?? "").trim().toLowerCase() === "true";
}

/** Como o canal se chama PARA O USUÁRIO — a rota não pode escrever a marca. */
export const CHAT_DE_VENDEDOR_LABEL = "OLX";

/**
 * Raiz da API de chat. `||` e `trim()` juntos, como no canal parceiro: o
 * `.env.example` entrega a chave VAZIA prometendo "vazio usa a produção", e
 * string vazia passaria pelo `??`, montando URL sem host.
 */
export function chatDeVendedorApiBase(
  valor: string | undefined = process.env.OLX_API_BASE_URL,
): string {
  return (valor?.trim() || "https://apps.olx.com.br").replace(/\/+$/, "");
}

export interface CredencialChatDeVendedor {
  /** `channel_sessions.id` — a conexão. */
  channelSessionId: string;
  /** `channel_sessions.olx_seller_id` — é o `sessionRef` do adapter. */
  sellerId: string;
  /** Access token OAuth 2.0 (scope `chat`), DECIFRADO. */
  token: string;
}

/**
 * O access token gravado na sessão DESTA organização que atende esta conta de
 * vendedor. É por aqui que o `send` fala com a OLX — a coluna
 * `olx_token_encrypted` deixou de ser "coluna vazia" (medição do mantidor em
 * 22/10) no momento em que este módulo passou a lê-la.
 *
 * `null` = não há token gravado (canal não conectado). **LANÇA quando a
 * consulta falha** — descartar o `error` foi metade do defeito da issue #236.
 */
export async function resolveTokenChatDeVendedor(
  admin: SupabaseClient,
  lookup: { organizationId: string; sellerId: string },
): Promise<CredencialChatDeVendedor | null> {
  const { organizationId, sellerId } = lookup;
  if (!organizationId || !sellerId) return null;

  const base = () =>
    admin
      .from("channel_sessions")
      .select("id, olx_seller_id, olx_token_encrypted")
      .eq("organization_id", organizationId)
      .eq("olx_seller_id", sellerId);
  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (error) {
    throw new Error(
      `chat_de_vendedor_creds_lookup_failed: ${error.code ?? "sem_codigo"} ${error.message ?? ""}`.trim(),
    );
  }

  const cifrado = (data as { olx_token_encrypted?: unknown } | null)?.olx_token_encrypted;
  if (!data || !cifrado) return null;

  const token = await decryptWebhookSecret(admin, cifrado as string);
  if (!token) return null;

  const linha = data as { id: string; olx_seller_id: string };
  return { channelSessionId: linha.id, sellerId: linha.olx_seller_id, token };
}
