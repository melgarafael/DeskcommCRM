/**
 * Ingestão da mensagem que o COMPRADOR mandou no chat da OLX (#2927).
 *
 * ─── Reusa as operações canônicas, como todo canal ─────────────────────────
 *
 * `fn_upsert_wa_contact` / `fn_upsert_wa_conversation` / `fn_mark_conversation_message`
 * são agnósticas de provider e resolvem contato/conversa numa transação, cada
 * uma com a sua corrida já tratada. Escrever um segundo upsert aqui seria criar
 * um segundo lugar onde a mesma corrida pode voltar — a lição que o canal
 * intermediado pagou caro (`zernio/ingest.ts`, `upsertConversation`).
 *
 * ─── IDEMPOTÊNCIA: o `messageId` é a chave ─────────────────────────────────
 *
 * A OLX reentrega o webhook, como todo provedor. A garantia é a MESMA dos
 * outros canais e não depende de nada novo: `messages.external_id` guarda o
 * `messageId` da OLX, e o índice `unique (organization_id, external_id)` faz a
 * segunda entrega devolver `23505`. Aqui isso vira `{status:"duplicate"}` — que
 * é sucesso, não erro: a mensagem já está na conversa, uma vez só.
 *
 * ─── ÂNCORA DO CONTATO: sem telefone, o `chatId` ───────────────────────────
 *
 * O comprador da OLX pode vir sem telefone (o payload traz `phone`, `email` e
 * `name`, todos opcionais na prática). O `fn_upsert_wa_contact` só conhece duas
 * âncoras — telefone e identidade opaca (`p_lid`). Sem telefone usamos o
 * `chatId` como identidade opaca: é estável, é único por thread e é a única
 * coluna de identidade que o upsert aceita hoje. A coluna se chama `wa_lid` por
 * história (nasceu no WhatsApp); o VALOR aqui não é LID nenhum, e nenhuma regra
 * de WhatsApp é aplicada sobre ele.
 *
 * ─── O que este módulo NÃO faz, de propósito ───────────────────────────────
 *
 * Não chama `aplicarEfeitosPosEntrada`: nascimento de negócio, despacho do
 * agente e aviso de conversa nova são a fatia seguinte do canal e dependem de o
 * canal estar ligado (credencial). Enquanto não estiver, a mensagem entra no
 * inbox e é isso que se prova.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { previaDaMensagem } from "@/lib/messaging/previa-da-mensagem";

import { marcarConversaComMensagem } from "../marcar-conversa";
import { canonicalPhoneBR } from "../phone-variants";
import type { MensagemOlx } from "./webhook";

export type IngestOutcomeOlx =
  | { status: "ingested"; messageId: string; conversationId: string }
  | { status: "duplicate" }
  | { status: "failed"; reason: string };

/**
 * O contato, pela âncora disponível. Devolve o id ou lança: devolver `null`
 * faria a entrada responder `ignored` e o evento aceito fechar como processado
 * sem ter entrado em lugar nenhum.
 */
async function upsertContato(
  admin: SupabaseClient,
  organizationId: string,
  mensagem: MensagemOlx,
): Promise<string> {
  const telefone = mensagem.telefone ? canonicalPhoneBR(mensagem.telefone) : null;
  const kind = telefone ? "phone" : "lid";

  const { data, error } = await admin.rpc("fn_upsert_wa_contact" as never, {
    p_org: organizationId,
    p_kind: kind,
    p_phone: telefone,
    // Identidade opaca: só quando não há telefone. Com telefone, o `chatId`
    // continua gravado em `p_chat_id` (metadata), sem virar âncora.
    p_lid: telefone ? null : mensagem.chatId,
    p_chat_id: mensagem.chatId,
    p_notify: mensagem.nome,
  } as never);

  if (error) throw new Error(`olx_contact_upsert_failed: ${error.message}`);
  const contactId = (data as string | null) ?? null;
  if (!contactId) throw new Error("olx_contact_upsert_failed: sem id");
  return contactId;
}

/**
 * A conversa desta thread. `provider_conversation_id` é escrito SEMPRE e sem
 * condição: em SQL `NULL <> 'valor'` é NULL, então "só escrever se mudou" nunca
 * alcança a conversa recém-criada (medido no canal intermediado — o update não
 * pegava linha nenhuma e responder era impossível).
 */
async function upsertConversa(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    contactId: string;
    channelSessionId: string;
    chatId: string;
  },
): Promise<string> {
  const { data, error } = await admin.rpc("fn_upsert_wa_conversation" as never, {
    p_org: input.organizationId,
    p_contact: input.contactId,
    p_session: input.channelSessionId,
  } as never);
  if (error) throw new Error(`olx_conversation_upsert_failed: ${error.message}`);
  const conversationId = (data as string | null) ?? null;
  if (!conversationId) throw new Error("olx_conversation_upsert_failed: sem id");

  await admin
    .from("conversations")
    .update({ provider_conversation_id: input.chatId })
    .eq("id", conversationId);

  return conversationId;
}

export async function ingestOlxInbound(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    channelSessionId: string;
    mensagem: MensagemOlx;
  },
): Promise<IngestOutcomeOlx> {
  const { organizationId, channelSessionId, mensagem } = input;

  try {
    const contactId = await upsertContato(admin, organizationId, mensagem);
    const conversationId = await upsertConversa(admin, {
      organizationId,
      contactId,
      channelSessionId,
      chatId: mensagem.chatId,
    });

    const { data: inserida, error: erroInsert } = await admin
      .from("messages")
      .insert({
        organization_id: organizationId,
        conversation_id: conversationId,
        // NOT NULL na tabela: sem ele o insert falha e a falha vira "recebido: 1"
        // com nada gravado (foi o defeito medido no canal oficial).
        channel_session_id: channelSessionId,
        contact_id: contactId,
        direction: "inbound",
        status: "delivered",
        type: "text",
        body: mensagem.texto,
        external_id: mensagem.messageId,
        sent_at: mensagem.recebidaEm.toISOString(),
        metadata: {
          // O que é da OLX fica ANINHADO: nada aqui é lido por regra de outro
          // canal, e o `channel` da conversa segue o que o banco já sabe.
          olx: {
            chat_id: mensagem.chatId,
            list_id: mensagem.anuncioId,
            origin: mensagem.origin,
            sender_type: mensagem.senderType,
            ...(mensagem.email ? { email: mensagem.email } : {}),
          },
        },
      })
      .select("id")
      .maybeSingle();

    // 23505 = o mesmo `messageId` já entrou. É a OLX reentregando: uma mensagem,
    // não duas.
    if (erroInsert) {
      if (erroInsert.code === "23505") return { status: "duplicate" };
      throw new Error(`olx_message_insert_failed: ${erroInsert.message}`);
    }

    const messageId = (inserida as { id: string } | null)?.id ?? "";
    if (!messageId) throw new Error("olx_message_insert_failed: sem id");

    await marcarConversaComMensagem(admin, {
      organizationId,
      conversationId,
      direction: "inbound",
      preview: previaDaMensagem(mensagem.texto, "text"),
      at: mensagem.recebidaEm.toISOString(),
      canal: "olx",
    });

    return { status: "ingested", messageId, conversationId };
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : "olx_ingest_failed" };
  }
}
