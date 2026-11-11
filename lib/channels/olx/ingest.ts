/**
 * Ingestão do canal do chat de vendedor da OLX (issue #2927): webhook →
 * contato, conversa, mensagem.
 *
 * A leitura do payload é do módulo puro ao lado (`../adapters/olx`:
 * `lerEntradaOlx`); aqui moram os EFEITOS, no molde de `lib/channels/zernio/ingest.ts`.
 *
 * ─── O que este módulo grava ────────────────────────────────────────────────
 *
 * `conversations.provider_conversation_id` com o `chatId` da OLX. Sem ele o
 * envio não funciona — o endereço deste canal não se deriva do contato (a
 * plataforma endereça por THREAD) —, e este é o único lugar por onde a thread
 * chega. Mensagem gravada sem a thread deixa a conversa visível no Inbox e o
 * operador sem conseguir responder.
 *
 * ─── Idempotência ───────────────────────────────────────────────────────────
 *
 * A chave é `unique (organization_id, external_id)` no INSERT da mensagem, com
 * captura do `23505` — o mesmo corte dos irmãos. Sem isso, uma reentrega
 * duplica a mensagem no Inbox do cliente.
 *
 * ─── O que a conta do vendedor manda entra como SAÍDA ───────────────────────
 *
 * A OLX entrega no MESMO webhook o que saiu da conta do vendedor
 * (`origin: "seller"`), e o chat continua no app e no site dela depois de
 * ligar o webhook (resposta da OLX na issue #2927, 15/10). Descartar tudo que
 * é `seller` deixava a conversa com buracos: a resposta que o vendedor deu pelo
 * app nunca aparecia no Inbox. Então ela entra como `outbound`, carimbada
 * `external_device`, e a IA pausa nesta conversa — uma pessoa respondeu à mão.
 *
 * O eco do NOSSO envio não vira segunda linha: ele volta com o `messageId` que
 * o adapter gerou, a nossa linha já tem esse `external_id`, e o `23505` o
 * devolve como `duplicate` (se o eco chegar antes de a nossa linha ganhar o id,
 * a limpeza do eco no handler de envio o apaga). Que a OLX ecoe o mesmo id é
 * contrato ainda não medido contra a conta real.
 *
 * Saída para uma thread que não conhecemos é ignorada: os campos de pessoa
 * dessa mensagem podem ser do próprio vendedor, e criar contato com eles daria
 * ao vendedor uma ficha de cliente.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { audit } from "@/lib/audit";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { marcarConversaComMensagem } from "@/lib/channels/marcar-conversa";
import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
import {
  pausarIaPorAtendimentoManual,
  type FalhaDaPausa,
} from "@/lib/escalacao/atendimento-manual";

import { saiuDaConta, type MensagemDeEntradaOlx } from "../adapters/olx";

/** `conversations.channel` deste canal. Ver `CANAIS_DE_CONVERSA`. */
const CANAL_DA_CONVERSA = "olx";

/**
 * Aviso durável de que a pausa da IA não foi garantida (#534). A pausa é o que
 * impede a IA de falar por cima do atendente; quando ela não grava, o desfecho
 * `ingested` não pode sair limpo — o registro vai para o audit, não para o log.
 */
function avisarPausaNaoGravada(falha: FalhaDaPausa): Promise<void> {
  return audit({
    action: "ai.pausa_nao_gravada",
    organizationId: falha.organizationId,
    resourceType: "conversation",
    resourceId: falha.conversationId,
    metadata: {
      canal: falha.canal ?? CANAL_DA_CONVERSA,
      motivo: falha.motivo,
      detalhe: falha.detalhe ?? null,
    },
  });
}

export interface IngestResultOlx {
  status: "ingested" | "duplicate" | "ignored";
  conversationId?: string;
  messageId?: string;
  /** Por que foi ignorado — vai para o arquivo do webhook e é o que se lê quando "sumiu". */
  reason?: string;
}

/**
 * Grava um evento já lido (contrato conferido pela leitura pura) e
 * autenticado (token do path conferido pela rota).
 *
 * Recebe o `channelSessionId` resolvido pela rota: este módulo não descobre de
 * quem é o webhook, só escreve o que já se sabe de quem é.
 */
export async function ingestOlxInbound(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    channelSessionId: string;
    mensagem: MensagemDeEntradaOlx;
  },
): Promise<IngestResultOlx> {
  const { mensagem } = input;

  // A thread é a prova de identidade, e vem ANTES da âncora do contato: se já
  // existe conversa com este `chatId` nesta sessão, é a MESMA pessoa — perguntar
  // de novo "quem é?" pelo telefone abriria espaço para dois contatos para uma
  // pessoa só (o defeito medido no canal intermediado).
  const existente = await conversaPelaThread(
    admin,
    input.organizationId,
    mensagem.chatId,
    input.channelSessionId,
  );
  if (existente) {
    const inserida = await inserirMensagem(admin, {
      organizationId: input.organizationId,
      conversationId: existente.id,
      contactId: existente.contact_id,
      channelSessionId: input.channelSessionId,
      mensagem,
    });
    if (inserida === "duplicate") return { status: "duplicate", conversationId: existente.id };
    await depoisDeGravar(admin, input, mensagem, existente.contact_id, existente.id, inserida);
    return { status: "ingested", conversationId: existente.id, messageId: inserida };
  }

  if (saiuDaConta(mensagem)) return { status: "ignored", reason: "saida_sem_conversa" };

  // Sem telefone e sem a thread não há contato possível. Recusar é o certo:
  // criar contato anônimo faria a próxima mensagem da MESMA pessoa virar um
  // segundo contato.
  const identity = identidadeDaMensagem(mensagem);
  if (!identity) return { status: "ignored", reason: "sem_identidade_utilizavel" };

  const contactId = await upsertContato(admin, input.organizationId, mensagem, identity);
  if (!contactId) return { status: "ignored", reason: "contato_nao_resolvido" };

  const conversationId = await upsertConversa(admin, {
    organizationId: input.organizationId,
    contactId,
    channelSessionId: input.channelSessionId,
    providerConversationId: mensagem.chatId,
  });
  if (!conversationId) return { status: "ignored", reason: "conversa_nao_resolvida" };

  const inserted = await inserirMensagem(admin, {
    organizationId: input.organizationId,
    conversationId,
    contactId,
    channelSessionId: input.channelSessionId,
    mensagem,
  });
  if (inserted === "duplicate") return { status: "duplicate", conversationId };

  await depoisDeGravar(admin, input, mensagem, contactId, conversationId, inserted);
  return { status: "ingested", conversationId, messageId: inserted };
}

/**
 * O que vem depois da linha gravada. Entrada: os efeitos de negócio. Saída pelo
 * app da OLX: a IA pausa, como em todo canal onde a pessoa responde por fora.
 */
async function depoisDeGravar(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string },
  mensagem: MensagemDeEntradaOlx,
  contactId: string,
  conversationId: string,
  messageId: string,
): Promise<void> {
  await marcarConversa(admin, input.organizationId, conversationId, mensagem);
  if (saiuDaConta(mensagem)) {
    await pausarIaPorAtendimentoManual(admin, {
      organizationId: input.organizationId,
      conversationId,
      canal: CANAL_DA_CONVERSA,
      avisar: avisarPausaNaoGravada,
    });
    return;
  }
  await efeitosDaEntrada(admin, input, mensagem, contactId, conversationId, messageId);
}

/**
 * A âncora desta mensagem no vocabulário dos contatos: `phone:<E.164>` quando a
 * OLX traz telefone, senão `lid:<chatId>` — a mesma NATUREZA de identificador
 * opaco que o canal por QR usa, um id que a plataforma inventa. Reusar o
 * prefixo faz o contato ser o mesmo quando a pessoa aparece pelos dois canais;
 * inventar um terceiro criaria dois contatos para uma pessoa só.
 */
function identidadeDaMensagem(mensagem: MensagemDeEntradaOlx): string | null {
  const digitos = (mensagem.phone ?? "").replace(/\D/g, "");
  if (digitos.length > 0) return `phone:${digitos}`;
  return mensagem.chatId ? `lid:${mensagem.chatId}` : null;
}

/** A conversa que esta thread já tem nesta sessão, se houver. */
async function conversaPelaThread(
  admin: SupabaseClient,
  organizationId: string,
  providerConversationId: string,
  channelSessionId: string,
): Promise<{ id: string; contact_id: string } | null> {
  const { data } = await admin
    .from("conversations")
    .select("id, contact_id")
    .eq("organization_id", organizationId)
    .eq("channel_session_id", channelSessionId)
    .eq("provider_conversation_id", providerConversationId)
    .maybeSingle();
  const row = data as { id: string; contact_id: string | null } | null;
  return row?.contact_id ? { id: row.id, contact_id: row.contact_id } : null;
}

/**
 * Reusa a RPC do canal por QR: ela resolve a corrida de dois webhooks
 * simultâneos numa transação, e um segundo upsert escrito aqui seria um
 * segundo lugar onde a mesma corrida pode voltar.
 *
 * O `kind` é `phone` quando a OLX traz telefone, `lid` quando só há a thread.
 * No segundo caso o `chatId` vai no slot de identidade opaca — é o id opaco
 * que ESTE canal tem, e descartá-lo criaria contato sem nenhuma âncora.
 */
async function upsertContato(
  admin: SupabaseClient,
  organizationId: string,
  mensagem: MensagemDeEntradaOlx,
  identity: string,
): Promise<string | null> {
  const kind = identity.startsWith("phone:") ? "phone" : "lid";
  const valor = identity.slice(identity.indexOf(":") + 1);
  const phoneBruto = kind === "phone" ? valor : (mensagem.phone ?? null);
  const phone = phoneBruto ? canonicalPhoneBR(phoneBruto) : null;

  const { data, error } = await admin.rpc("fn_upsert_wa_contact", {
    p_org: organizationId,
    p_kind: kind,
    p_phone: phone,
    p_lid: kind === "lid" ? valor : null,
    p_chat_id: mensagem.chatId,
    p_notify: mensagem.name,
  });
  if (error) return null;
  const contactId = (data as string) ?? null;
  if (!contactId) return null;

  // O telefone entra MESMO quando a âncora é a thread: a RPC só grava
  // `phone_number` quando o kind é phone, e sem número o atendente não sabe
  // com quem está falando. `is null`: só preenche o que está vazio.
  if (phone && kind !== "phone") {
    await admin
      .from("contacts")
      .update({ phone_number: phone })
      .eq("id", contactId)
      .is("phone_number", null);
  }

  return contactId;
}

async function upsertConversa(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    contactId: string;
    channelSessionId: string;
    providerConversationId: string;
  },
): Promise<string | null> {
  const { data, error } = await admin.rpc("fn_upsert_wa_conversation", {
    p_org: input.organizationId,
    p_contact: input.contactId,
    p_session: input.channelSessionId,
  });
  if (error || !data) return null;
  const conversationId = data as string;

  // A thread do provider, SEMPRE e sem condição: numa conversa recém-criada a
  // coluna é NULL, e `NULL <> 'valor'` é NULL — um filtro "só escrever se
  // mudou" nunca alcançaria a linha nova (defeito medido no canal intermediado).
  // O canal entra junto: a RPC nasce a conversa como `whatsapp`, e sem esta
  // troca a conversa da OLX aparecia (e o negócio nascia) como WhatsApp.
  const { error: erroDaConversa } = await admin
    .from("conversations")
    .update({ provider_conversation_id: input.providerConversationId, channel: CANAL_DA_CONVERSA })
    .eq("organization_id", input.organizationId)
    .eq("id", conversationId);
  if (erroDaConversa) throw new Error(`olx_conversation_update_failed: ${erroDaConversa.message}`);

  return conversationId;
}

/**
 * A mensagem no Inbox, com `external_id` = `messageId` da OLX.
 *
 * `sent_via: "external_device"` como nos irmãos: quem passou por aqui chegou
 * pelo webhook, não pelo composer — e sem o carimbo as três funções de fricção
 * (que contam só este valor) leriam "zero atendimento por fora".
 */
async function inserirMensagem(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    conversationId: string;
    contactId: string;
    channelSessionId: string;
    mensagem: MensagemDeEntradaOlx;
  },
): Promise<string | "duplicate"> {
  const { mensagem } = input;
  const { data, error } = await admin
    .from("messages")
    .insert({
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      contact_id: input.contactId,
      channel_session_id: input.channelSessionId,
      external_id: mensagem.messageId,
      direction: saiuDaConta(mensagem) ? "outbound" : "inbound",
      sent_via: "external_device",
      status: saiuDaConta(mensagem) ? "sent" : "delivered",
      type: "text",
      body: mensagem.message,
      // `sent_at` do provider quando existe: a ordem da lista e o cálculo da
      // janela usam a hora em que o cliente ESCREVEU, não a do webhook chegar.
      ...(mensagem.messageTimestamp ? { sent_at: mensagem.messageTimestamp } : {}),
      metadata: {
        olx_list_id: mensagem.listId,
        olx_sender_type: mensagem.senderType,
      },
    })
    .select("id")
    .maybeSingle();

  // 23505 = unique violation em (organization_id, external_id). É o desfecho
  // ESPERADO de uma reentrega, não um erro: o provider reenvia quando não
  // recebe 200, e tratar isto como falha faria a rota devolver 500 e ele
  // reenviar de novo, para sempre.
  if (error?.code === "23505") return "duplicate";
  if (error || !data) {
    logger.error("[olx] insert da mensagem falhou", {
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      detail: error?.message ?? "sem id",
    });
    throw new Error(`olx_ingest_insert_failed: ${error?.message ?? "sem id"}`);
  }
  return (data as { id: string }).id;
}

/** Carimba a conversa com o que acabou de chegar (fonte da janela e do contador). */
async function marcarConversa(
  admin: SupabaseClient,
  organizationId: string,
  conversationId: string,
  mensagem: MensagemDeEntradaOlx,
): Promise<void> {
  await marcarConversaComMensagem(admin, {
    organizationId,
    conversationId,
    direction: saiuDaConta(mensagem) ? "outbound" : "inbound",
    preview: (mensagem.message ?? "").slice(0, 200),
    at: mensagem.messageTimestamp ?? new Date().toISOString(),
    canal: CANAL_DA_CONVERSA,
  });
}

/**
 * Os efeitos de negócio da mensagem que acabou de entrar — o passo
 * COMPARTILHADO (`lib/channels/pos-entrada.ts`), nunca uma cópia privada: a
 * cópia é o que deixou um canal irmão sem opt-out, sem demanda e sem despacho.
 */
async function efeitosDaEntrada(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string },
  mensagem: MensagemDeEntradaOlx,
  contactId: string,
  conversationId: string,
  messageId: string,
): Promise<void> {
  await aplicarEfeitosPosEntrada(admin, {
    organizationId: input.organizationId,
    contactId,
    conversationId,
    messageId,
    channelSessionId: input.channelSessionId,
    texto: mensagem.message,
    nomeDoContato: mensagem.name,
    origem: "olx_webhook",
    canal: CANAL_DA_CONVERSA,
  });
}
