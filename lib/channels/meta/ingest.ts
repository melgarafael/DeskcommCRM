/**
 * Ingestão de mensagem RECEBIDA pelo canal oficial — a metade que faltava.
 *
 * Sem ela o canal é um megafone: o cliente responde e nada chega, nenhum lead se
 * move, o agente não acorda, e a janela de 24h — que deriva de
 * `conversations.last_inbound_at` — nunca abre. O gate da Fase 4 vetaria para sempre
 * e o sistema só saberia falar por template.
 *
 * ─── Reusa as MESMAS operações canônicas do outro canal ─────────────────────
 * `fn_upsert_wa_contact` / `fn_upsert_wa_conversation` / `fn_mark_conversation_message`
 * já resolvem contato e conversa de forma atômica, e são agnósticas de provider. O
 * que muda aqui é só o mapeamento do payload — escrever uma segunda resolução de
 * contato seria criar a divergência que a migration 0027 (wa_identity canônica)
 * eliminou.
 *
 * ─── Duas armadilhas medidas contra a WABA real ─────────────────────────────
 * 1. **O `wa_id` pode vir sem o nono dígito** (`553198966398` para quem recebemos
 *    como `5531998966398`). A resolução do contato passa por `phoneLookupVariants`,
 *    senão a mesma pessoa vira dois cadastros e a conversa parte ao meio.
 * 2. **A Meta re-entrega tudo que não recebe 2xx.** A idempotência por
 *    `unique (organization_id, external_id)` não é higiene, é obrigatória: sem ela a
 *    mesma mensagem aparece N vezes no inbox depois de qualquer instabilidade.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { aplicarEfeitosPosEntrada } from "../pos-entrada";
import { encontrarContatoPorTelefone } from "../contato-por-telefone";
import { canonicalPhoneBR, phoneLookupVariants } from "../phone-variants";
import type { ChannelTenantScope } from "../types";
import type { InboundMessageEvent } from "./webhook";

type Admin = SupabaseClient;

export type IngestOutcome =
  | { status: "ingested"; messageId: string; conversationId: string }
  | { status: "duplicate" }
  | { status: "no_session" }
  | { status: "failed"; reason: string };

/**
 * Sessão dona do número que RECEBEU, **dentro da organização do token**.
 *
 * O cabeçalho anterior já dizia "nunca confiamos no corpo para escolher
 * organização" — e a consulta fazia exatamente isso: `phoneNumberId` sai do
 * corpo do webhook e era o ÚNICO filtro. Duas organizações com o mesmo número
 * (configuração legítima: agência, migração entre organizações) faziam
 * `maybeSingle()` casar duas linhas, devolver `data: null` com `PGRST116` — e,
 * com o `error` descartado, a mensagem que acabou de chegar era descartada para
 * as DUAS, com a rota respondendo 200 (issue #236).
 *
 * A organização vem de `dono`, resolvido pela rota a partir do TOKEN DO PATH
 * (`metaSessionByWebhookToken`) — a mesma fonte confiável que já decide onde o
 * status de template e o status de mensagem são gravados nesse handler. O
 * número continua no filtro porque uma organização pode ter mais de um número
 * oficial, e é ele que diz QUAL sessão recebeu.
 *
 * Sessão ARQUIVADA não é dona de nada: o usuário excluiu o canal. Sem este
 * filtro, o desfecho `no_session` (que o chamador loga e devolve no corpo) vira
 * uma mensagem gravada num canal que já não existe para o operador.
 *
 * **LANÇA quando a consulta falha**, para o chamador gravar `failed` com o
 * motivo em vez de `no_session`. "Não achei" e "não consegui perguntar" pedem
 * ações diferentes do operador, e colapsá-los foi metade do defeito.
 */
async function sessionByPhoneNumberId(
  admin: Admin,
  organizationId: string,
  phoneNumberId: string,
) {
  const base = () =>
    admin
      .from("channel_sessions")
      .select("id, organization_id")
      .eq("organization_id", organizationId)
      .eq("meta_phone_number_id", phoneNumberId);
  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (error) {
    throw new Error(
      `sessao_do_numero: ${error.code ?? "sem_codigo"} ${error.message ?? ""}`.trim(),
    );
  }
  return data;
}

/**
 * Contato já existente sob QUALQUER variante do número. Só depois de não achar é que
 * deixamos o upsert criar — assim o cadastro nasce uma vez só.
 */
/**
 * Delega para `encontrarContatoPorTelefone`, que decide QUAL grafia vence.
 *
 * Era uma cópia local com `.in(variantes).limit(1)` — sem `order by`, e sem o
 * filtro de contato fundido. Três funções idênticas viviam assim no repo; a
 * regra agora mora num lugar só.
 */
async function findContactByVariants(
  admin: Admin,
  orgId: string,
  waId: string,
): Promise<{ id: string; phone_number: string } | null> {
  return encontrarContatoPorTelefone(admin as never, orgId, waId);
}

/** Prévia curta para a lista de conversas. Mídia vira rótulo, nunca URL. */
function previewOf(e: InboundMessageEvent): string {
  if (e.type === "text") return (e.text ?? "").slice(0, 120);
  if (e.type === "contact") return e.sharedContact?.name ? `👤 ${e.sharedContact.name}` : "[contato]";
  if (e.type === "audio") return e.media?.voice ? "🎤 Mensagem de voz" : "🎵 Áudio";
  if (e.type === "image") return "📷 Imagem";
  if (e.type === "video") return "🎬 Vídeo";
  if (e.type === "document") return "📎 Documento";
  return `[${e.type}]`;
}

export async function ingestMetaInbound(
  admin: Admin,
  e: InboundMessageEvent,
  dono: ChannelTenantScope,
): Promise<IngestOutcome> {
  let sessao: { id: string; organization_id: string } | null;
  try {
    sessao = await sessionByPhoneNumberId(admin, dono.organizationId, e.phoneNumberId);
  } catch (err) {
    // Falhar FECHADO na ação (nada é gravado) e ABERTO na informação: o motivo
    // sobe como `failed` e o chamador o escreve no log e no corpo.
    return { status: "failed", reason: err instanceof Error ? err.message : "sessao_do_numero" };
  }
  // Sem sessão: a mensagem é de um número que não administramos. Devolver 200 (o
  // chamador faz isso) evita a Meta re-entregar em loop algo que nunca vamos aceitar.
  if (!sessao) return { status: "no_session" };

  const orgId = sessao.organization_id;

  const existente = await findContactByVariants(admin, orgId, e.from);
  // Celular BR grava COM o nono. A busca acima já reencontra a grafia sem o 9;
  // a RPC promove o cadastro antigo quando ainda está nos 12 dígitos.
  const phone = existente?.phone_number
    ? canonicalPhoneBR(existente.phone_number)
    : canonicalPhoneBR(`+${e.from.replace(/\D/g, "")}`);

  const { data: contactId, error: erroContato } = await admin.rpc(
    "fn_upsert_wa_contact" as never,
    {
      p_org: orgId,
      p_kind: "phone",
      p_phone: phone,
      p_lid: null,
      p_chat_id: e.from,
      p_notify: e.profileName,
    } as never,
  );
  if (erroContato || !contactId) {
    return { status: "failed", reason: `contato: ${erroContato?.message ?? "sem id"}` };
  }

  const { data: conversationId, error: erroConversa } = await admin.rpc(
    "fn_upsert_wa_conversation" as never,
    { p_org: orgId, p_contact: contactId as string, p_session: sessao.id } as never,
  );
  if (erroConversa || !conversationId) {
    return { status: "failed", reason: `conversa: ${erroConversa?.message ?? "sem id"}` };
  }

  const { data: inserida, error: erroInsert } = await admin
    .from("messages")
    .insert({
      organization_id: orgId,
      conversation_id: conversationId as string,
      // NOT NULL na tabela. Esquecê-lo fez o insert falhar e — porque a rota
      // descartava o resultado — a falha virou "recebido: 1" com nada gravado.
      channel_session_id: sessao.id,
      contact_id: contactId as string,
      direction: "inbound",
      status: "delivered",
      // A Meta manda `contacts` (plural); o CHECK do banco espera `contact`.
      type: e.type === "text" ? "text" : e.type,
      body: e.type === "contact" ? (e.sharedContact?.name ?? e.text) : e.text,
      external_id: e.externalId,
      // O webhook oficial entrega o media_id, não um arquivo que o browser
      // consiga abrir. Mantemos um ponteiro opaco para o adapter resolver pela
      // Graph API; sem ele a bolha nem é renderizada e o worker pula a mídia.
      media_url: e.media ? `meta-media:${e.media.id}` : null,
      media_mime: e.media?.mime ?? null,
      sent_at: e.sentAt.toISOString(),
      metadata: {
        ...(e.media ? { meta_media_id: e.media.id, voice: e.media.voice } : {}),
        ...(e.sharedContact ? { shared_contact: e.sharedContact } : {}),
      },
    })
    .select("id")
    .maybeSingle();

  // 23505 = a mesma `external_id` já entrou. Não é erro: é a Meta re-entregando.
  if (erroInsert) {
    if (erroInsert.code === "23505") return { status: "duplicate" };
    return { status: "failed", reason: `mensagem: ${erroInsert.message}` };
  }

  // Carimba a conversa — é ISTO que move `last_inbound_at` e abre a janela de 24h.
  // Falha aqui não derruba a ingestão (a mensagem já entrou), mas o preview e a
  // janela ficariam desatualizados, então o erro sobe como `failed` parcial no log
  // do chamador em vez de sumir.
  await admin.rpc("fn_mark_conversation_message" as never, {
    p_conv: conversationId as string,
    p_direction: "inbound",
    p_preview: previewOf(e),
    p_at: e.sentAt.toISOString(),
  } as never);

  const messageId = (inserida as { id: string } | null)?.id ?? "";
  if (e.media && messageId) {
    const { error: erroPersistencia } = await admin.rpc("emit_event" as never, {
      p_event_type: "media.persist_requested",
      p_entity_kind: "message",
      p_entity_id: messageId,
      p_payload: { message_id: messageId, conversation_id: conversationId as string },
      p_metadata: { source: "meta_webhook" },
      p_organization_id: orgId,
    } as never);
    if (erroPersistencia) {
      console.error(
        "[meta.ingest] emit media.persist_requested failed",
        erroPersistencia.message,
      );
    }
  }
  await aplicarEfeitosPosEntrada(admin, {
    organizationId: orgId,
    contactId: contactId as string,
    conversationId: conversationId as string,
    messageId: messageId || null,
    channelSessionId: sessao.id,
    texto: e.text ?? null,
    nomeDoContato: e.profileName ?? null,
    origem: "meta_webhook",
  });

  return {
    status: "ingested",
    messageId,
    conversationId: conversationId as string,
  };
}
