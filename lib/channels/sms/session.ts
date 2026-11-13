/**
 * Canal de SMS (#4415) — a linha de `channel_sessions` da conexão.
 *
 * Uma conexão de SMS por organização nesta fatia, como o canal parceiro:
 * conectar de novo (outro número, chave trocada) reaproveita a mesma linha,
 * reativando-a se estava arquivada. A chave da conta vai para
 * `webhook_secret_encrypted` (ver `./credentials.ts`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";

import { CHANNEL_PROVIDER_TWILIO } from "../capabilities";
import { reactivateChannelSession } from "../reactivate";

export interface SessaoDeSms {
  id: string;
  numeroId: string | null;
  contaId: string | null;
  numero: string | null;
  displayName: string | null;
  status: string | null;
  webhookPathToken: string | null;
  temChave: boolean;
  archivedAt: string | null;
}

const COLUNAS =
  "id, twilio_phone_number_sid, twilio_account_sid, phone_number, display_name, status, webhook_path_token, webhook_secret_encrypted, archived_at";

function paraSessao(row: Record<string, unknown> | null): SessaoDeSms | null {
  if (!row) return null;
  return {
    id: row.id as string,
    numeroId: (row.twilio_phone_number_sid as string) ?? null,
    contaId: (row.twilio_account_sid as string) ?? null,
    numero: (row.phone_number as string) ?? null,
    displayName: (row.display_name as string) ?? null,
    status: (row.status as string) ?? null,
    webhookPathToken: (row.webhook_path_token as string) ?? null,
    temChave: !!row.webhook_secret_encrypted,
    archivedAt: (row.archived_at as string) ?? null,
  };
}

/** A conexão de SMS da organização: a ativa primeiro, senão a arquivada mais recente. */
export async function acharSessaoDeSms(admin: SupabaseClient, organizationId: string): Promise<SessaoDeSms | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_TWILIO)
    .order("archived_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`sms_session_lookup_failed: ${error.message}`);
  return paraSessao((data as Record<string, unknown>[] | null)?.[0] ?? null);
}

export async function salvarSessaoDeSms(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    existente: SessaoDeSms | null;
    numeroId: string;
    contaId: string;
    numero: string;
    chaveCifrada: string;
    displayName: string;
    userId: string;
    requestId: string;
  },
): Promise<{ error: string | null; channelSessionId: string | null; webhookPathToken: string | null }> {
  const linha = {
    organization_id: input.organizationId,
    provider: CHANNEL_PROVIDER_TWILIO,
    twilio_phone_number_sid: input.numeroId,
    twilio_account_sid: input.contaId,
    phone_number: input.numero,
    display_name: input.displayName,
    webhook_secret_encrypted: input.chaveCifrada,
    status: "WORKING",
  };

  if (input.existente) {
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
        metadata: { provider: CHANNEL_PROVIDER_TWILIO, phone_number: input.numero },
      },
    );
    return {
      error: r.error?.message ?? null,
      channelSessionId: input.existente.id,
      webhookPathToken: input.existente.webhookPathToken,
    };
  }

  // `webhook_path_token` nasce do default da coluna: o token da URL de
  // recebimento é do banco, nunca do corpo da requisição.
  const { data, error } = await admin
    .from("channel_sessions")
    .insert({ ...linha, metadata: metadataInicialDoCanal() })
    .select("id, webhook_path_token")
    .maybeSingle();
  const row = data as { id: string; webhook_path_token: string } | null;
  return {
    error: error?.message ?? null,
    channelSessionId: row?.id ?? null,
    webhookPathToken: row?.webhook_path_token ?? null,
  };
}
