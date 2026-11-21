/**
 * Persistência da sessão do canal do chat de vendedor (issue #2927).
 *
 * A rota não pode nomear o provider nem as colunas dele (invariante 1 de
 * `docs/doctrine/restricao-de-canal.md`, vigiado por `lint:channels`); ela fala
 * em "o canal", "a conta de vendedor", "o token". A leitura e a escrita moram
 * aqui, no molde de `lib/channels/graph-parceiro/session.ts`.
 *
 * Toda consulta leva `organization_id` À MÃO: o client é de service role e
 * ignora a RLS.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";

import { CHANNEL_PROVIDER_OLX } from "../capabilities";
import { reactivateChannelSession } from "../reactivate";

export interface ChatDeVendedorSession {
  id: string;
  sellerId: string | null;
  displayName: string | null;
  status: string | null;
  webhookPathToken: string | null;
  hasToken: boolean;
  archivedAt: string | null;
}

const COLUNAS =
  "id, olx_seller_id, display_name, status, webhook_path_token, olx_token_encrypted, archived_at";

function toSessao(row: Record<string, unknown> | null): ChatDeVendedorSession | null {
  if (!row) return null;
  return {
    id: row.id as string,
    sellerId: (row.olx_seller_id as string) ?? null,
    displayName: (row.display_name as string) ?? null,
    status: (row.status as string) ?? null,
    webhookPathToken: (row.webhook_path_token as string) ?? null,
    hasToken: Boolean(row.olx_token_encrypted),
    archivedAt: (row.archived_at as string) ?? null,
  };
}

/**
 * A sessão deste canal na organização — a ATIVA primeiro. Reconectar por cima
 * de uma arquivada precisa trazer a linha de volta, não criar outra ao lado.
 *
 * LANÇA quando a consulta falha: "não há sessão" e "não consegui perguntar"
 * levam a desfechos diferentes (conectar de novo × tentar depois).
 */
export async function findChatDeVendedorSession(
  admin: SupabaseClient,
  organizationId: string,
): Promise<ChatDeVendedorSession | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_OLX)
    .order("archived_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`chat_de_vendedor_session_lookup_failed: ${error.message}`);
  return toSessao((data as Record<string, unknown>[] | null)?.[0] ?? null);
}

/**
 * Grava (ou ressuscita) a sessão com o access token recém-validado.
 *
 * `webhook_secret_encrypted` nasce ALEATÓRIO, nunca um segredo que confere:
 * a coluna é NOT NULL por herança do schema do canal por QR, e a OLX não
 * documenta assinatura de webhook (issue #2927, "pontos abertos") — quem
 * autentica a entrega é o token do path, gerado aqui e registrado na conta do
 * vendedor. Gravar o access token nesta coluna seria guardar a mesma
 * credencial duas vezes.
 */
export async function saveChatDeVendedorSession(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    existente: ChatDeVendedorSession | null;
    sellerId: string;
    tokenEncrypted: string;
    segredoProvisorioCifrado: string;
    webhookPathToken: string;
    displayName: string;
    userId: string;
    requestId: string;
  },
): Promise<{ error: string | null; channelSessionId: string | null }> {
  const linha = {
    organization_id: input.organizationId,
    provider: CHANNEL_PROVIDER_OLX,
    olx_seller_id: input.sellerId,
    olx_token_encrypted: input.tokenEncrypted,
    webhook_path_token: input.webhookPathToken,
    display_name: input.displayName,
    status: "WORKING",
  };

  if (input.existente) {
    // Reconectar é RESSUSCITAR: o mesmo update devolve token, conta e a linha
    // à vida, e a auditoria da volta sai de `reactivateChannelSession`.
    const r = await reactivateChannelSession(
      admin,
      {
        organizationId: input.organizationId,
        channelSessionId: input.existente.id,
        archivedAt: input.existente.archivedAt,
      },
      linha,
      {
        userId: input.userId,
        requestId: input.requestId,
        metadata: { provider: CHANNEL_PROVIDER_OLX, seller_id: input.sellerId },
      },
    );
    return { error: r.error?.message ?? null, channelSessionId: input.existente.id };
  }

  const { data, error } = await admin
    .from("channel_sessions")
    .insert({
      ...linha,
      webhook_secret_encrypted: input.segredoProvisorioCifrado,
      metadata: metadataInicialDoCanal(),
    })
    .select("id")
    .maybeSingle();
  return {
    error: error?.message ?? null,
    channelSessionId: (data as { id: string } | null)?.id ?? null,
  };
}
