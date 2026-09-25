/**
 * Persistência da sessão do canal Datafy — do lado de dentro do seam
 * (recorte do #1130, @vgamkt).
 *
 * A rota e a tela não podem nomear o provider nem as colunas dele (invariante 1
 * de `docs/doctrine/restricao-de-canal.md`, vigiado por `lint:channels`); elas
 * falam em "o número", "o token", "o segredo". A leitura e a escrita moram aqui.
 *
 * Toda consulta leva `organization_id` À MÃO: o client é de service role e
 * ignora a RLS.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";

import { CHANNEL_PROVIDER_DATAFY } from "../capabilities";
import { reactivateChannelSession } from "../reactivate";

export interface GraphPartnerSession {
  id: string;
  phoneNumberId: string | null;
  wabaId: string | null;
  displayName: string | null;
  phoneNumber: string | null;
  status: string | null;
  webhookPathToken: string | null;
  hasToken: boolean;
  /** Cifrado; quem precisa saber se é um segredo de assinatura decifra no servidor. */
  webhookSecretEncrypted: string | null;
  archivedAt: string | null;
}

const COLUNAS =
  "id, datafy_phone_number_id, datafy_waba_id, phone_number, display_name, status, webhook_path_token, datafy_token_encrypted, webhook_secret_encrypted, archived_at";

function toSessao(row: Record<string, unknown> | null): GraphPartnerSession | null {
  if (!row) return null;
  return {
    id: row.id as string,
    phoneNumberId: (row.datafy_phone_number_id as string) ?? null,
    wabaId: (row.datafy_waba_id as string) ?? null,
    phoneNumber: (row.phone_number as string) ?? null,
    displayName: (row.display_name as string) ?? null,
    status: (row.status as string) ?? null,
    webhookPathToken: (row.webhook_path_token as string) ?? null,
    hasToken: !!row.datafy_token_encrypted,
    webhookSecretEncrypted: (row.webhook_secret_encrypted as string) ?? null,
    archivedAt: (row.archived_at as string) ?? null,
  };
}

/**
 * A sessão deste canal na organização — a ATIVA primeiro. Reconectar por cima de
 * uma arquivada precisa trazer a linha de volta, não criar outra ao lado dela.
 *
 * LANÇA quando a consulta falha: "não há sessão" e "não consegui perguntar"
 * levam a desfechos diferentes (conectar de novo × tentar depois).
 */
export async function findGraphPartnerSession(
  admin: SupabaseClient,
  organizationId: string,
): Promise<GraphPartnerSession | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_DATAFY)
    .order("archived_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`graph_partner_session_lookup_failed: ${error.message}`);
  return toSessao((data as Record<string, unknown>[] | null)?.[0] ?? null);
}

/**
 * Grava (ou ressuscita) a sessão com o token recém-validado.
 *
 * O segredo de assinatura NÃO é tocado numa reconexão: trocar o token não pode
 * desligar o recebimento que já estava funcionando. Numa sessão nova ele nasce
 * com `segredoProvisorioCifrado` — um valor aleatório que não é `whsec_`, então a
 * entrada recusa tudo até o operador colar o segredo do painel (a coluna é NOT
 * NULL, e deixar o token do provedor nela seria guardar a mesma credencial duas
 * vezes).
 */
export async function saveGraphPartnerSession(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    existente: GraphPartnerSession | null;
    phoneNumberId: string;
    wabaId: string;
    tokenEncrypted: string;
    segredoProvisorioCifrado: string;
    phoneNumber: string | null;
    displayName: string;
    userId: string;
    requestId: string;
  },
): Promise<{ error: string | null; channelSessionId: string | null }> {
  const linha = {
    organization_id: input.organizationId,
    provider: CHANNEL_PROVIDER_DATAFY,
    datafy_phone_number_id: input.phoneNumberId,
    datafy_waba_id: input.wabaId,
    datafy_token_encrypted: input.tokenEncrypted,
    phone_number: input.phoneNumber,
    display_name: input.displayName,
    status: "WORKING",
  };

  if (input.existente) {
    // Reconectar é RESSUSCITAR: o mesmo update devolve credencial, número e a
    // linha à vida, e a auditoria da volta sai de `reactivateChannelSession`.
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
        metadata: { provider: CHANNEL_PROVIDER_DATAFY, phone_number: input.phoneNumber },
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

/** Grava o segredo de assinatura do painel na sessão ATIVA desta organização. */
export async function saveGraphPartnerSigningSecret(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; secretEncrypted: string },
): Promise<{ error: string | null }> {
  const { error } = await admin
    .from("channel_sessions")
    .update({ webhook_secret_encrypted: input.secretEncrypted })
    .eq("organization_id", input.organizationId)
    .eq("id", input.channelSessionId)
    .eq("provider", CHANNEL_PROVIDER_DATAFY)
    .is("archived_at", null);
  return { error: error?.message ?? null };
}

/**
 * O número e a conta que ESTA sessão atende — para a entrada conferir que o
 * evento é dela. A sessão veio do token do webhook; o número vem do corpo, e o
 * corpo não escolhe nada sozinho.
 */
export async function graphPartnerRefsDaSessao(
  admin: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
): Promise<{ phoneNumberId: string | null; wabaId: string | null }> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("datafy_phone_number_id, datafy_waba_id")
    .eq("organization_id", organizationId)
    .eq("id", channelSessionId)
    .maybeSingle();
  if (error) throw new Error(`graph_partner_refs_lookup_failed: ${error.message}`);
  const row = data as { datafy_phone_number_id?: string | null; datafy_waba_id?: string | null } | null;
  return { phoneNumberId: row?.datafy_phone_number_id ?? null, wabaId: row?.datafy_waba_id ?? null };
}
