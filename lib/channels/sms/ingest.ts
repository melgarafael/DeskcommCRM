/**
 * Canal de SMS (#4415) — o SMS recebido vira contato, conversa e mensagem.
 *
 * O endereço é o TELEFONE: quem já é contato (pelo WhatsApp, por cadastro, por
 * importação) é achado pelo número e a conversa de SMS nasce AO LADO das
 * outras, na mesma ficha. Quem é novo nasce com `source = 'sms'`.
 *
 * NÃO usa `fn_upsert_wa_contact`: aquela função grava `phone_whatsapp = 'sim'`
 * e `source = 'whatsapp'` em todo contato que cria — afirmar que um número que
 * só mandou SMS tem WhatsApp faria a IA e as automações tentarem o canal
 * errado. A busca é a mesma do resto do CRM (`encontrarContatoPorTelefone`,
 * principal e telefones extras); a criação é daqui.
 *
 * A conversa nasce pelo mesmo `fn_upsert_wa_conversation` (um par contato ×
 * conexão = uma conversa, índice `uniq_conversations_1to1_per_contact_session`)
 * e é carimbada `channel = 'sms'` logo em seguida — o mesmo desenho do canal do
 * Telegram (#3486), porque a função grava `whatsapp` fixo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { ehCanalDeConversa } from "../canais-de-conversa";
import { encontrarContatoPorTelefone } from "../contato-por-telefone";
import { marcarConversaComMensagem } from "../marcar-conversa";
import { canonicalPhoneBR } from "../phone-variants";
import { aplicarEfeitosPosEntrada } from "../pos-entrada";
import type { SmsRecebido } from "./twilio";

export const CANAL_SMS = "sms";

export type SmsIngestResult =
  | { status: "ingested"; conversationId: string; messageId: string }
  | { status: "duplicate"; conversationId: string }
  | { status: "ignored"; reason: string };

export async function ingerirSmsRecebido(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; sms: SmsRecebido },
): Promise<SmsIngestResult> {
  const { organizationId, channelSessionId, sms } = input;

  // Segunda linha de defesa: o CHECK do banco precisa conhecer `sms`
  // (migration 9345). Sem ele o carimbo da conversa falharia DEPOIS de o
  // contato nascer — melhor recusar inteiro e dizer por quê no log.
  if (!ehCanalDeConversa(CANAL_SMS)) {
    logger.error("[sms] canal sem valor correspondente no banco — mensagem não gravada", {
      organization_id: organizationId,
      detalhe: "falta 'sms' no CHECK de conversations.channel (migration 9345)",
    });
    return { status: "ignored", reason: "canal_desconhecido" };
  }

  const contactId = await contatoDoTelefone(admin, organizationId, sms.de);
  const conversationId = await conversaDeSms(admin, { organizationId, contactId, channelSessionId });

  const texto = sms.texto;
  const { data, error } = await admin
    .from("messages")
    .insert({
      organization_id: organizationId,
      conversation_id: conversationId,
      contact_id: contactId,
      channel_session_id: channelSessionId,
      external_id: sms.externalId,
      direction: "inbound",
      status: "delivered",
      type: "text",
      body: texto,
      metadata: sms.quantidadeDeMidias > 0 ? { sms_midias_nao_baixadas: sms.quantidadeDeMidias } : {},
      sent_at: new Date().toISOString(),
    })
    .select("id")
    .maybeSingle();
  // Reentrega do mesmo SMS: `unique (organization_id, external_id)`.
  if (error?.code === "23505") return { status: "duplicate", conversationId };
  if (error || !data) throw new Error(`sms_ingest_insert_failed: ${error?.message ?? "sem id"}`);
  const messageId = (data as { id: string }).id;

  await marcarConversaComMensagem(admin, {
    organizationId,
    conversationId,
    direction: "inbound",
    preview: (texto || (sms.quantidadeDeMidias > 0 ? "[mídia]" : "")).slice(0, 200),
    at: new Date().toISOString(),
    canal: CANAL_SMS,
  });

  // STOP/UNSUBSCRIBE (lib/opt-out/deteccao.ts), negócio novo, roteamento e o
  // turno do agente: o mesmo funil de todo canal.
  await aplicarEfeitosPosEntrada(admin, {
    organizationId,
    contactId,
    conversationId,
    messageId,
    channelSessionId,
    texto: texto || null,
    nomeDoContato: null,
    origem: "sms_webhook",
    canal: CANAL_SMS,
  });

  return { status: "ingested", conversationId, messageId };
}

async function contatoDoTelefone(admin: SupabaseClient, organizationId: string, telefone: string): Promise<string> {
  const existente = await encontrarContatoPorTelefone(admin, organizationId, telefone);
  if (existente) return existente.id;

  const phone = canonicalPhoneBR(telefone);
  const { data, error } = await admin
    .from("contacts")
    .insert({
      organization_id: organizationId,
      phone_number: phone,
      source: CANAL_SMS,
      consent: {},
      tags: [],
      source_metadata: { sms_from: telefone },
    })
    .select("id")
    .single();

  // Corrida perdida contra outra entrada do mesmo número (`uniq_contacts_org_phone`).
  if (error?.code === "23505") {
    const vencedor = await encontrarContatoPorTelefone(admin, organizationId, telefone);
    if (!vencedor) throw new Error("sms_contact_race_failed");
    return vencedor.id;
  }
  if (error || !data) throw new Error(`sms_contact_create_failed: ${error?.code ?? ""}`.trim());
  return (data as { id: string }).id;
}

async function conversaDeSms(
  admin: SupabaseClient,
  input: { organizationId: string; contactId: string; channelSessionId: string },
): Promise<string> {
  const { data, error } = await admin.rpc("fn_upsert_wa_conversation" as never, {
    p_org: input.organizationId,
    p_contact: input.contactId,
    p_session: input.channelSessionId,
  } as never);
  if (error || !data) throw new Error("sms_conversation_upsert_failed");
  const conversationId = data as string;

  const { error: erroDoCarimbo } = await admin
    .from("conversations")
    .update({ channel: CANAL_SMS })
    .eq("organization_id", input.organizationId)
    .eq("id", conversationId);
  if (erroDoCarimbo) throw new Error(`sms_conversation_update_failed: ${erroDoCarimbo.code ?? ""}`.trim());
  return conversationId;
}
