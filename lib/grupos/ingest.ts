/**
 * Mensagem de um grupo LIGADO entra na inbox. Grupo desligado é descartado, como sempre foi.
 *
 * O que esta entrada NÃO faz, de propósito: `aplicarEfeitosPosEntrada` (opt-out, lead,
 * atribuição), `acelerarPipelineDeEventos` e o audit `message.received`. O banco emite
 * `message.group_received` para conversa de grupo (migration 0411), e nenhum
 * consumidor de `message.received` — IA, follow-up, campanhas, automações — a vê.
 *
 * Quem chama é a entrada do canal (o ingest do transporte, em `lib/`): ela lê o payload do
 * provedor, monta a `EntradaDeGrupo` e não sabe mais nada de grupo daqui para baixo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { marcarConversaComMensagem } from "@/lib/channels/marcar-conversa";
import { logger } from "@/lib/logger";
import { remetenteDeGrupoSchema, type RemetenteDeGrupo } from "@/lib/messaging/remetente-de-grupo";

export interface EntradaDeGrupo {
  organizationId: string;
  channelSessionId: string;
  groupChatId: string;
  direction: "inbound" | "outbound";
  externalId: string;
  type: string;
  body: string | null;
  mediaUrl: string | null;
  mediaMime: string | null;
  sentAt: string;
  remetente: RemetenteDeGrupo | null;
  rawType: string | null;
  /**
   * O provedor anunciou mídia mas não mandou a URL. A conversa individual grava
   * essa mensagem mesmo assim (`!texto && !mediaUrl && !hasMedia` é o descarte
   * dela); o grupo segue a mesma régua para não perder a foto que chegou sem link.
   */
  temMidia?: boolean;
}

export interface IngestDeGrupoDb {
  grupoLigado(
    org: string,
    session: string,
    chatId: string,
  ): Promise<{ id: string; subject: string | null; contactId: string | null; conversationId: string | null } | null>;
  criarContatoDoGrupo(org: string, chatId: string, subject: string | null): Promise<string>;
  criarConversaDoGrupo(org: string, session: string, contactId: string, chatId: string): Promise<string>;
  vincular(org: string, grupoId: string, contactId: string, conversationId: string): Promise<void>;
  inserirMensagem(row: Record<string, unknown>): Promise<"ok" | "duplicada">;
  /**
   * Conversa de grupo FECHADA (closed/resolved/archived) volta a `open` quando chega
   * mensagem nova — o que a conversa individual faz em `fn_service_inbound`, que pula grupos.
   * Sem isto, um "resolver" num grupo esconde para sempre as mensagens seguintes em
   * "Fechadas". Não aciona roteamento: `fn_request_channel_routing` pula `is_group`.
   */
  reabrirSeFechada(org: string, conversationId: string): Promise<void>;
  /**
   * `direction` vai no fim porque o carimbo compartilhado
   * (`fn_mark_conversation_message`) move `last_inbound_at` OU `last_outbound_at`
   * e o contador de não lidas conforme o sentido — sem ele, o carimbo erraria.
   */
  marcarConversa(
    org: string,
    conversationId: string,
    preview: string,
    quando: string,
    direction: "inbound" | "outbound",
  ): Promise<void>;
}

export async function gravarMensagemDeGrupo(
  db: IngestDeGrupoDb,
  e: EntradaDeGrupo,
): Promise<"gravada" | "grupo_desligado" | "duplicada" | "vazia"> {
  if (!e.body && !e.mediaUrl && !e.temMidia) return "vazia";
  const grupo = await db.grupoLigado(e.organizationId, e.channelSessionId, e.groupChatId);
  if (!grupo) return "grupo_desligado";

  let contactId = grupo.contactId;
  let conversationId = grupo.conversationId;
  if (!contactId || !conversationId) {
    contactId ??= await db.criarContatoDoGrupo(e.organizationId, e.groupChatId, grupo.subject);
    conversationId ??= await db.criarConversaDoGrupo(e.organizationId, e.channelSessionId, contactId, e.groupChatId);
    await db.vincular(e.organizationId, grupo.id, contactId, conversationId);
  }

  // Remetente fora do formato NÃO derruba a mensagem: ela entra sem `group_sender`
  // e a tela mostra "Participante". Perder a mensagem por causa do rótulo seria pior.
  const remetente = e.direction === "inbound" && e.remetente ? remetenteDeGrupoSchema.safeParse(e.remetente) : null;
  const agora = new Date().toISOString();
  const resultado = await db.inserirMensagem({
    organization_id: e.organizationId,
    conversation_id: conversationId,
    channel_session_id: e.channelSessionId,
    contact_id: contactId,
    external_id: e.externalId,
    type: e.type,
    direction: e.direction,
    status: e.direction === "inbound" ? "delivered" : "sent",
    body: e.body,
    media_url: e.mediaUrl,
    media_mime: e.mediaMime,
    sent_via: "external_device",
    sent_at: e.sentAt,
    delivered_at: e.direction === "inbound" ? agora : null,
    metadata: {
      raw_type: e.rawType,
      ...(remetente?.success ? { group_sender: remetente.data } : {}),
    },
  });
  if (resultado === "duplicada") return "duplicada";
  if (e.direction === "inbound") await db.reabrirSeFechada(e.organizationId, conversationId);
  // Mesma prévia da conversa individual (`previewFromMessage`): texto até 280, ou `[tipo]`.
  const preview = e.body ? e.body.slice(0, 280) : e.type !== "text" ? `[${e.type}]` : "";
  await db.marcarConversa(e.organizationId, conversationId, preview, e.sentAt, e.direction);
  return "gravada";
}

/** Implementação real. `admin` é service role: toda consulta filtra `organization_id`. */
export function criarIngestDeGrupoDb(admin: SupabaseClient): IngestDeGrupoDb {
  return {
    async grupoLigado(org, session, chatId) {
      const { data, error } = await admin
        .from("channel_session_groups")
        .select("id, subject, contact_id, conversation_id")
        .eq("organization_id", org)
        .eq("channel_session_id", session)
        .eq("group_chat_id", chatId)
        .eq("enabled", true)
        .maybeSingle();
      // Leitura que falhou é "não sei se está ligado": descarta, como antes da
      // feature. Fica o rastro, para "o grupo ligado não entra" ter resposta.
      if (error) {
        logger.warn("[grupos.ingest] chave do grupo não lida; mensagem descartada", {
          organization_id: org,
          causa: error.message,
        });
        return null;
      }
      const r = data as { id: string; subject: string | null; contact_id: string | null; conversation_id: string | null } | null;
      return r ? { id: r.id, subject: r.subject, contactId: r.contact_id, conversationId: r.conversation_id } : null;
    },

    async criarContatoDoGrupo(org, chatId, subject) {
      const nome = subject?.trim() || "Grupo de WhatsApp";
      const { data, error } = await admin
        .from("contacts")
        .insert({
          organization_id: org,
          name: nome,
          display_name: nome,
          kind: "whatsapp_group",
          source: "whatsapp_group",
          source_metadata: { group_chat_id: chatId },
        })
        .select("id")
        .single();
      if (!error) return (data as { id: string }).id;
      if ((error as { code?: string }).code !== "23505") throw error;
      // Dois webhooks do MESMO grupo novo (o provedor manda `message` e
      // `message.any`) correram, e o outro criou primeiro: `uq_contacts_grupo`
      // recusou este. Relê o contato dele — um grupo, um contato.
      const { data: existente, error: erroLeitura } = await admin
        .from("contacts")
        .select("id")
        .eq("organization_id", org)
        .eq("kind", "whatsapp_group")
        .eq("source_metadata->>group_chat_id", chatId)
        .maybeSingle();
      if (erroLeitura) throw erroLeitura;
      if (!existente) throw error;
      return (existente as { id: string }).id;
    },

    async criarConversaDoGrupo(org, session, contactId, chatId) {
      const { data, error } = await admin
        .from("conversations")
        .insert({
          organization_id: org,
          contact_id: contactId,
          channel_session_id: session,
          channel: "whatsapp",
          status: "open",
          is_group: true,
          group_chat_id: chatId,
        })
        .select("id")
        .single();
      if (!error) return (data as { id: string }).id;
      if ((error as { code?: string }).code !== "23505") throw error;
      // Mesma corrida do contato. O unique é
      // `conversations_unique_per_contact_session (organization_id, contact_id,
      // channel_session_id, group_chat_id)`: relê pelos quatro.
      const { data: existente, error: erroLeitura } = await admin
        .from("conversations")
        .select("id")
        .eq("organization_id", org)
        .eq("contact_id", contactId)
        .eq("channel_session_id", session)
        .eq("group_chat_id", chatId)
        .maybeSingle();
      if (erroLeitura) throw erroLeitura;
      if (!existente) throw error;
      return (existente as { id: string }).id;
    },

    async vincular(org, grupoId, contactId, conversationId) {
      const { error } = await admin
        .from("channel_session_groups")
        .update({ contact_id: contactId, conversation_id: conversationId })
        .eq("organization_id", org)
        .eq("id", grupoId);
      if (error) {
        logger.warn("[grupos.ingest] vínculo do grupo não gravado", {
          organization_id: org,
          grupo_id: grupoId,
          causa: error.message,
        });
      }
    },

    async inserirMensagem(row) {
      const { data, error } = await admin.from("messages").insert(row).select("id").maybeSingle();
      if (error) {
        if ((error as { code?: string }).code === "23505") return "duplicada";
        throw error;
      }
      // "Mídia pelo mesmo caminho das conversas individuais" (spec): a URL do
      // provedor é temporária, e quem a copia para o Storage é o worker de
      // `media.persist_requested`. Sem isto a foto do grupo some em horas.
      const id = (data as { id: string } | null)?.id;
      if (id && row.media_url) {
        const org = row.organization_id as string;
        const { error: erroEvento } = await admin.rpc("emit_event" as never, {
          p_event_type: "media.persist_requested",
          p_entity_kind: "message",
          p_entity_id: id,
          p_payload: { message_id: id, conversation_id: row.conversation_id },
          p_metadata: { source: "grupo_ingest" },
          p_organization_id: org,
        } as never);
        if (erroEvento) {
          logger.warn("[grupos.ingest] persistência de mídia não pedida", {
            organization_id: org,
            message_id: id,
            causa: erroEvento.message,
          });
        }
      }
      return "ok";
    },

    async reabrirSeFechada(org, conversationId) {
      // `trg_service_stamp_status` carimba a revisão de serviço e limpa o dono,
      // como na reabertura da conversa individual. O filtro `is_group` garante
      // que este caminho nunca reabre uma conversa 1:1.
      const { error } = await admin
        .from("conversations")
        .update({ status: "open", status_changed_at: new Date().toISOString() })
        .eq("organization_id", org)
        .eq("id", conversationId)
        .eq("is_group", true)
        .in("status", ["closed", "resolved", "archived"]);
      if (error) {
        logger.warn("[grupos.ingest] conversa de grupo fechada não reaberta", {
          organization_id: org,
          conversation_id: conversationId,
          causa: error.message,
        });
      }
    },

    async marcarConversa(org, conversationId, preview, quando, direction) {
      await marcarConversaComMensagem(admin, {
        organizationId: org,
        conversationId,
        direction,
        preview,
        at: quando,
        canal: "grupo",
      });
    },
  };
}
