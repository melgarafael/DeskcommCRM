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
import {
  PROVIDERS_DE_MENSAGEM,
  PROVIDERS_DE_TELEFONE,
  type ProviderDeMensagem,
} from "@/lib/channels/capabilities";


/** O que o CHAMADOR sabe sobre o destino e esta porta não pode adivinhar. */
export interface PreferenciaDeSessao {
  /**
   * O destino é um TELEFONE — o número que a pessoa deixou ou o `phone_number`
   * do contato. Só quem resolveu o telefone sabe disso; a organização pode ter
   * Instagram e WhatsApp ao mesmo tempo.
   */
  preferirTelefone?: boolean;
}

/**
 * Sessão viva da org: WORKING primeiro; senão qualquer uma não arquivada.
 *
 * ─── A PREFERÊNCIA DO CHAMADOR (#3358) ───────────────────────────────────────
 * A regra sozinha escolhe a sessão de MENSAGEM `WORKING` mais ANTIGA da
 * organização. Isso está errado quando o destino é um TELEFONE: numa
 * organização que conectou o Instagram/Facebook antes do WhatsApp — a ordem em
 * que as conexões costumam ser feitas — a escolhida era a social, e a rede
 * social não tem telefone (o contato de lá é outro endereço, e o envio fora da
 * janela de 24h é recusado). O lembrete de tarefa saía pelo Instagram e não
 * chegava.
 *
 * Com `preferirTelefone`, os degraus passam a ser:
 *
 *   telefone WORKING → telefone qualquer → mensagem WORKING → mensagem qualquer
 *
 * A preferência vem ANTES do degrau de vivacidade de propósito: um canal social
 * `WORKING` continua sem alcançar telefone nenhum, então preferi-lo ali não é
 * escolher o melhor dos dois — é escolher o único que não pode funcionar, e
 * quem recebe a falha lê "confira a conexão" sem haver conexão a conferir.
 *
 * Sem sessão de WhatsApp na organização, a cadeia termina na regra de sempre (a
 * de mensagem mais antiga) — a preferência reordena, nunca inventa canal. E
 * quem não passa a opção continua escolhendo exatamente como antes: o `create`
 * de contato e a conversa compartilhada (inclusive pelo MCP) ainda chamam sem a
 * opção, embora também tenham o telefone na mão (continuação do #3358).
 */
export async function sessaoProntaParaEnvio(
  supabase: SupabaseClient,
  organizationId: string,
  preferencia: PreferenciaDeSessao = {},
): Promise<string | null> {
  const listar = (
    providers: readonly ProviderDeMensagem[],
    soWorking: boolean,
    ignorarArquivadas: boolean,
  ) => {
    let q = supabase
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", organizationId);
    // Voz não manda texto: escolher a linha de chamada aqui faria a automação
    // "enviar" por um canal sem transporte de mensagem (spec 18).
    q = q.in("provider", [...providers]);
    if (soWorking) q = q.eq("status", "WORKING");
    if (ignorarArquivadas) q = q.is(ARCHIVED_AT, null);
    return q.order("created_at", { ascending: true }).limit(1);
  };
  const tentar = async (
    providers: readonly ProviderDeMensagem[],
    soWorking: boolean,
  ) => {
    const { data } = await queryTolerantToMissingArchived(
      () => listar(providers, soWorking, true),
      () => listar(providers, soWorking, false),
    );
    return (data as Array<{ id: string }> | null)?.[0]?.id ?? null;
  };

  // Sem a preferência a lista tem UMA entrada e os degraus são os mesmos de
  // antes desta issue: WORKING, senão qualquer uma não arquivada.
  const filtros: ReadonlyArray<readonly ProviderDeMensagem[]> = preferencia.preferirTelefone
    ? [PROVIDERS_DE_TELEFONE, PROVIDERS_DE_MENSAGEM]
    : [PROVIDERS_DE_MENSAGEM];

  for (const providers of filtros) {
    for (const soWorking of [true, false]) {
      const id = await tentar(providers, soWorking);
      if (id) return id;
    }
  }
  return null;
}

export async function ensureConversation(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
  channelSessionId: string,
): Promise<string> {
  return (await beginServiceAtOrigin(admin, organizationId, contactId, channelSessionId)).conversation_id;
}
