/**
 * Persistência da sessão do canal Datafy — do lado de dentro do seam.
 *
 * A rota e a tela não podem nomear o provider nem as colunas dele (invariante 1
 * da doutrina); elas falam em "o número", "o token", "o webhook". A leitura e a
 * escrita moram aqui, onde nomear é permitido.
 *
 * O `webhook_path_token` nasce do DEFAULT da coluna (`uuid_generate_v4()` sem
 * hífens) — não é escrito daqui. O `webhook_secret_encrypted` é NOT NULL, e
 * nesta primeira versão guardamos o próprio token cifrado: a assinatura do
 * Datafy é opcional (`whsec_` só existe se ativada no painel) e a proteção do
 * webhook é a URL secreta. Se um dia o `whsec_` for coletado, é aqui que ele
 * passa a ser guardado.
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
  archivedAt: string | null;
}

const COLUNAS =
  "id, datafy_phone_number_id, datafy_waba_id, phone_number, display_name, status, webhook_path_token, datafy_token_encrypted";

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
    archivedAt: (row.archived_at as string) ?? null,
  };
}

export async function findGraphPartnerSession(
  admin: SupabaseClient,
  organizationId: string,
): Promise<GraphPartnerSession | null> {
  const { data } = await admin
    .from("channel_sessions")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_DATAFY)
    // A ativa primeiro: reconectar por cima de uma arquivada precisa trazer a
    // linha de volta, não criar uma terceira ao lado dela.
    .order("archived_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(1);

  const linha = (data as Record<string, unknown>[] | null)?.[0] ?? null;
  return toSessao(linha);
}

/**
 * Grava (ou ressuscita) a sessão. `archived_at: null` sempre: reconectar por
 * cima de um canal excluído precisa trazê-lo de volta.
 */
export async function saveGraphPartnerSession(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    existingId: string | null;
    existingArchivedAt: string | null;
    phoneNumberId: string;
    wabaId: string;
    tokenEncrypted: string;
    phoneNumber: string | null;
    displayName: string;
    userId: string;
    requestId: string;
  },
): Promise<{ error: string | null }> {
  const linha = {
    organization_id: input.organizationId,
    provider: CHANNEL_PROVIDER_DATAFY,
    datafy_phone_number_id: input.phoneNumberId,
    datafy_waba_id: input.wabaId,
    datafy_token_encrypted: input.tokenEncrypted,
    webhook_secret_encrypted: input.tokenEncrypted,
    phone_number: input.phoneNumber,
    display_name: input.displayName,
    status: "WORKING",
    archived_at: null,
  };

  if (input.existingId) {
    // Reconectar é RESSUSCITAR: o mesmo patch que devolve credencial e número
    // tem de devolver a linha à vida (`archived_at: null`), ou o canal fica
    // "conectado" na tela e invisível para webhook/ingest/envio.
    const r = await reactivateChannelSession(
      admin,
      {
        organizationId: input.organizationId,
        channelSessionId: input.existingId,
        archivedAt: input.existingArchivedAt,
      },
      linha,
      {
        userId: input.userId,
        requestId: input.requestId,
        metadata: { provider: CHANNEL_PROVIDER_DATAFY, phone_number: input.phoneNumber },
      },
    );
    return { error: r.error?.message ?? null };
  }

  const { error } = await admin
    .from("channel_sessions")
    .insert({ ...linha, metadata: metadataInicialDoCanal() });

  return { error: error?.message ?? null };
}
