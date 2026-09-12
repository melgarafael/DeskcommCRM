import { beginServiceAtOrigin } from "@/lib/atendimento/origem";
/**
 * Conversa programática p/ automação: acha a conversa aberta do contato na
 * sessão, REABRE a fechada, ou cria uma nova. Distinto da ingestão WAHA (que
 * usa RPCs de identidade) — aqui contato e sessão já são conhecidos.
 *
 * Por que reabrir: o índice uniq_conversations_1to1_per_contact_session é
 * único por (org, contato, sessão) SEM filtro de status — um contato cuja
 * única conversa está closed/archived tornaria o INSERT impossível (23505) e
 * o envio automatizado falharia pra sempre. Reabrir é também o comportamento
 * certo de produto: a conversa É o thread com aquele contato naquele número.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { PROVIDERS_DE_MENSAGEM } from "@/lib/channels/capabilities";


/** Sessão viva da org: WORKING primeiro; senão qualquer uma não arquivada. */
export async function sessaoProntaParaEnvio(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<string | null> {
  const listar = (soWorking: boolean, ignorarArquivadas: boolean) => {
    let q = supabase
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", organizationId);
    // Voz não manda texto: escolher a linha de chamada aqui faria a automação
    // "enviar" por um canal sem transporte de mensagem (spec 18).
    q = q.in("provider", [...PROVIDERS_DE_MENSAGEM]);
    if (soWorking) q = q.eq("status", "WORKING");
    if (ignorarArquivadas) q = q.is(ARCHIVED_AT, null);
    return q.order("created_at", { ascending: true }).limit(1);
  };
  const tentar = async (soWorking: boolean) => {
    const { data } = await queryTolerantToMissingArchived(
      () => listar(soWorking, true),
      () => listar(soWorking, false),
    );
    return (data as Array<{ id: string }> | null)?.[0]?.id ?? null;
  };
  return (await tentar(true)) ?? (await tentar(false));
}

export async function ensureConversation(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
  channelSessionId: string,
): Promise<string> {
  return (await beginServiceAtOrigin(admin, organizationId, contactId, channelSessionId)).conversation_id;
}
