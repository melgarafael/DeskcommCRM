/**
 * Entrada do chat no site: mensagem do visitante → contato, conversa, mensagem.
 *
 * Molde do bot do Telegram (`lib/channels/bot/ingest.ts`): o contato entra por
 * `contacts.social_identity`, a conversa é endereçada por `provider_conversation_id`
 * (aqui, o id do visitante), e a mensagem é idempotente por `external_id`.
 *
 * ─── O que este canal tem de diferente ─────────────────────────────────────
 *
 * Nada de telefone nem de robô. A identidade é `webchat:<sessão>:<visitante>`:
 * o visitante não tem número, e o id da sessão separa dois sites da mesma
 * organização. O nome nasce como `NOME_DO_VISITANTE` até o visitante dizer o dele.
 *
 * ─── Idempotência ──────────────────────────────────────────────────────────
 *
 * O widget reenvia o que não recebeu resposta. A chave é `unique (organization_id,
 * external_id)` com `23505` lido como "duplicate", não como erro: tratar como erro
 * devolveria 500 e o reenvio nunca pararia. O `external_id` leva a sessão e o
 * visitante, para que o id de um visitante não engula a mensagem de outro.
 *
 * ─── Aceite de LGPD e coleta (primeira mensagem) ───────────────────────────
 *
 * "Primeira mensagem" = o visitante ainda não tem mensagem de entrada na conversa dele.
 * A checagem vem DEPOIS da idempotência: reenvio de mensagem já gravada devolve o
 * `duplicate` de sempre, sem exigir aceite. Na primeira, sem aceite ou sem um campo
 * `obrigatorio`, a ingestão recusa ANTES de criar contato, conversa ou mensagem.
 * A hora do aceite é a que chega em `aceite.em` (a rota põe a do servidor), e só a
 * primeira mensagem o grava em `messages.metadata.webchat_aceite`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { marcarConversaComMensagem } from "../marcar-conversa";
import { aplicarEfeitosPosEntrada } from "../pos-entrada";

import type { ModoDeColeta } from "./config";

/** `conversations.channel` e `contacts.source` deste canal. */
export const CANAL_WEBCHAT = "webchat";

/** Nome provisório do contato até o visitante informar o dele. */
export const NOME_DO_VISITANTE = "Visitante do site";

/** Os campos que o visitante pode informar no primeiro contato. */
export type CampoDeColeta = "nome" | "telefone" | "email";

export interface AceiteDoVisitante {
  versao: string;
  /** Hora do servidor, ISO-8601. A ingestão não a inventa: recebe a que a rota decidiu. */
  em: string;
}

export interface DadosDoContatoDoVisitante {
  nome?: string | undefined;
  telefone?: string | undefined;
  email?: string | undefined;
}

export type ColetaDoChat = Partial<Record<CampoDeColeta, ModoDeColeta>>;

export interface IngerirMensagemDoChatInput {
  organizationId: string;
  channelSessionId: string;
  visitanteId: string;
  mensagemId: string;
  texto: string;
  agora: Date;
  aceite?: AceiteDoVisitante | undefined;
  contato?: DadosDoContatoDoVisitante | undefined;
  coleta?: ColetaDoChat | undefined;
}

/** Por que a primeira mensagem não entrou. Não diz ao visitante qual campo falta. */
export type MotivoDaRecusa = "aceite_ausente" | "campo_obrigatorio";

export type IngerirMensagemDoChatResult =
  | { status: "ingested" | "duplicate"; conversationId: string; messageId: string | null }
  | { status: "recusada"; motivo: MotivoDaRecusa; conversationId: null; messageId: null };

const CAMPOS: readonly CampoDeColeta[] = ["nome", "telefone", "email"];

export async function ingerirMensagemDoChat(
  admin: SupabaseClient,
  p: IngerirMensagemDoChatInput,
): Promise<IngerirMensagemDoChatResult> {
  const identity = `webchat:${p.channelSessionId}:${p.visitanteId}`;
  const externalId = `wc:${p.channelSessionId}:${p.visitanteId}:${p.mensagemId}`;

  // Idempotência ANTES de tudo: um reenvio não cria nada e não pede nada.
  const jaGravada = await lerMensagemPeloExternalId(admin, p.organizationId, externalId);
  if (jaGravada) {
    return { status: "duplicate", conversationId: jaGravada.conversationId, messageId: null };
  }

  const contatoAtual = await lerContatoVivo(admin, p.organizationId, identity);
  const primeira = await ehAPrimeiraMensagem(admin, {
    organizationId: p.organizationId,
    channelSessionId: p.channelSessionId,
    contactId: contatoAtual,
  });
  if (primeira) {
    const motivo = motivoDaRecusa(p);
    if (motivo) return { status: "recusada", motivo, conversationId: null, messageId: null };
  }

  const contactId = contatoAtual ?? (await upsertContact(admin, p.organizationId, identity));
  const conversationId = await upsertConversation(admin, {
    organizationId: p.organizationId,
    contactId,
    channelSessionId: p.channelSessionId,
    visitanteId: p.visitanteId,
  });

  // Só a primeira mensagem grava os dados que o visitante informou. Nas seguintes o `contato`
  // é ignorado por completo: não sobrescreve o que o operador corrigiu no CRM.
  if (primeira) {
    await atualizarDadosDoContato(admin, {
      organizationId: p.organizationId,
      contactId,
      contato: p.contato,
      coleta: p.coleta,
    });
  }

  const inserted = await insertMessage(admin, {
    organizationId: p.organizationId,
    conversationId,
    contactId,
    channelSessionId: p.channelSessionId,
    externalId,
    texto: p.texto,
    sentAt: p.agora,
    ...(primeira && p.aceite
      ? { metadata: { webchat_aceite: { versao: p.aceite.versao, em: p.aceite.em } } }
      : {}),
  });
  if (inserted === "duplicate") return { status: "duplicate", conversationId, messageId: null };

  await marcarConversaComMensagem(admin, {
    organizationId: p.organizationId,
    conversationId,
    direction: "inbound",
    preview: p.texto.slice(0, 200),
    at: p.agora.toISOString(),
    canal: CANAL_WEBCHAT,
  });

  await aplicarEfeitosPosEntrada(admin, {
    organizationId: p.organizationId,
    contactId,
    conversationId,
    messageId: inserted,
    channelSessionId: p.channelSessionId,
    texto: p.texto,
    nomeDoContato: NOME_DO_VISITANTE,
    origem: "webchat_widget",
    canal: CANAL_WEBCHAT,
  });

  return { status: "ingested", conversationId, messageId: inserted };
}

/** O texto aparado do campo, ou `null` quando veio vazio ou ausente. */
function textoDoCampo(contato: DadosDoContatoDoVisitante | undefined, campo: CampoDeColeta): string | null {
  const bruto = contato?.[campo]?.trim();
  return bruto ? bruto : null;
}

/** O campo que a ingestão grava: `null` se o modo é `oculto` (o que o visitante mandou é ignorado). */
function valorGravavel(
  contato: DadosDoContatoDoVisitante | undefined,
  coleta: ColetaDoChat | undefined,
  campo: CampoDeColeta,
): string | null {
  if ((coleta?.[campo] ?? "opcional") === "oculto") return null;
  return textoDoCampo(contato, campo);
}

function motivoDaRecusa(p: IngerirMensagemDoChatInput): MotivoDaRecusa | null {
  if (!p.aceite) return "aceite_ausente";
  for (const campo of CAMPOS) {
    if (p.coleta?.[campo] === "obrigatorio" && !textoDoCampo(p.contato, campo)) return "campo_obrigatorio";
  }
  return null;
}

/**
 * O contato pela identidade social. O índice único é PARCIAL (`is_merged_into is
 * null`): uma linha fundida e uma viva com a mesma identidade são estado legítimo,
 * por isso a leitura filtra o VIVO.
 */
async function lerContatoVivo(admin: SupabaseClient, organizationId: string, identity: string): Promise<string | null> {
  const { data, error } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("social_identity", identity)
    .is("is_merged_into", null)
    .maybeSingle();
  if (error) throw new Error("webchat_contact_lookup_failed");
  return data ? (data as { id: string }).id : null;
}

async function upsertContact(admin: SupabaseClient, organizationId: string, identity: string): Promise<string> {
  const { data, error } = await admin
    .from("contacts")
    .insert({
      organization_id: organizationId,
      social_identity: identity,
      name: NOME_DO_VISITANTE,
      display_name: NOME_DO_VISITANTE,
      source: CANAL_WEBCHAT,
    })
    .select("id")
    .single();

  // 23505 = a mesma pessoa abriu duas mensagens ao mesmo tempo. Quem perdeu a
  // corrida procura o VIVO.
  if (error?.code === "23505") {
    const vivo = await lerContatoVivo(admin, organizationId, identity);
    if (!vivo) throw new Error("webchat_contact_race_failed");
    return vivo;
  }
  if (error || !data) throw new Error("webchat_contact_create_failed");
  return (data as { id: string }).id;
}

/**
 * Primeira mensagem = a conversa deste visitante não existe, ou não tem nenhuma mensagem
 * de entrada. A conversa é a de `(organização, contato, sessão)`, a mesma que a RPC cria.
 */
async function ehAPrimeiraMensagem(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; contactId: string | null },
): Promise<boolean> {
  if (!input.contactId) return true;

  const { data: conversa, error: erroConversa } = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("contact_id", input.contactId)
    .eq("channel_session_id", input.channelSessionId)
    .maybeSingle();
  if (erroConversa) throw new Error("webchat_conversation_lookup_failed");
  if (!conversa) return true;

  const { data: entrada, error: erroEntrada } = await admin
    .from("messages")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("conversation_id", (conversa as { id: string }).id)
    .eq("direction", "inbound")
    .limit(1)
    .maybeSingle();
  if (erroEntrada) throw new Error("webchat_message_lookup_failed");
  return entrada === null;
}

/** A mensagem já gravada com este `external_id`, ou `null`. */
async function lerMensagemPeloExternalId(
  admin: SupabaseClient,
  organizationId: string,
  externalId: string,
): Promise<{ conversationId: string } | null> {
  const { data, error } = await admin
    .from("messages")
    .select("conversation_id")
    .eq("organization_id", organizationId)
    .eq("external_id", externalId)
    .maybeSingle();
  if (error) throw new Error("webchat_message_lookup_failed");
  if (!data) return null;
  return { conversationId: (data as { conversation_id: string }).conversation_id };
}

/**
 * Grava os campos que o visitante informou. Campo `oculto` é ignorado; campo vazio ou
 * ausente não apaga o que o contato já tem; nome real não some por um vazio.
 */
async function atualizarDadosDoContato(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    contactId: string;
    contato: DadosDoContatoDoVisitante | undefined;
    coleta: ColetaDoChat | undefined;
  },
): Promise<void> {
  const nome = valorGravavel(input.contato, input.coleta, "nome");
  const telefone = valorGravavel(input.contato, input.coleta, "telefone");
  const email = valorGravavel(input.contato, input.coleta, "email");

  const patch: Record<string, string> = {};
  if (nome) {
    patch.name = nome;
    patch.display_name = nome;
  }
  if (telefone) patch.phone_number = telefone;
  if (email) patch.email = email;
  if (Object.keys(patch).length === 0) return;

  const { error } = await admin
    .from("contacts")
    .update(patch)
    .eq("organization_id", input.organizationId)
    .eq("id", input.contactId);

  // 23505: telefone ou e-mail já é de outro contato da organização. A mensagem entra mesmo
  // assim, sem o campo repetido; o nome, se veio, é gravado sozinho.
  if (error?.code === "23505") {
    logger.warn("webchat: telefone ou e-mail já usado por outro contato; mensagem gravada sem ele", {
      rota: "webchat_ingest",
    });
    if (!nome) return;
    const { error: erroNome } = await admin
      .from("contacts")
      .update({ name: nome, display_name: nome })
      .eq("organization_id", input.organizationId)
      .eq("id", input.contactId);
    if (erroNome) throw new Error(`webchat_contact_update_failed: ${erroNome.code ?? ""}`.trim());
    return;
  }
  if (error) throw new Error(`webchat_contact_update_failed: ${error.code ?? ""}`.trim());
}

/**
 * A conversa deste visitante, com o canal e o endereço gravados SEMPRE.
 *
 * `fn_upsert_wa_conversation` nasce a linha com `channel = 'whatsapp'`; o canal e
 * o `provider_conversation_id` entram no UPDATE logo depois, sem condição (`neq` em
 * SQL não alcança NULL, e a conversa recém-criada tem a coluna NULL).
 */
async function upsertConversation(
  admin: SupabaseClient,
  input: { organizationId: string; contactId: string; channelSessionId: string; visitanteId: string },
): Promise<string> {
  const { data, error } = await admin.rpc("fn_upsert_wa_conversation" as never, {
    p_org: input.organizationId,
    p_contact: input.contactId,
    p_session: input.channelSessionId,
  } as never);
  if (error || !data) throw new Error("webchat_conversation_upsert_failed");
  const conversationId = data as string;

  const { error: updateError } = await admin
    .from("conversations")
    .update({ channel: CANAL_WEBCHAT, provider_conversation_id: input.visitanteId })
    .eq("organization_id", input.organizationId)
    .eq("id", conversationId);
  if (updateError) {
    throw new Error(`webchat_conversation_update_failed: ${updateError.code ?? ""}`.trim());
  }

  return conversationId;
}

async function insertMessage(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    conversationId: string;
    contactId: string;
    channelSessionId: string;
    externalId: string;
    texto: string;
    sentAt: Date;
    metadata?: Record<string, unknown>;
  },
): Promise<string | "duplicate"> {
  const { error, data } = await admin
    .from("messages")
    .insert({
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      contact_id: input.contactId,
      channel_session_id: input.channelSessionId,
      external_id: input.externalId,
      direction: "inbound",
      // Chegou pelo webhook do widget, não pelo composer: o default `'crm'` mentiria.
      // `messages_sent_via_check` não aceita um valor próprio do webchat.
      sent_via: "external_device",
      status: "delivered",
      type: "text",
      body: input.texto,
      sent_at: input.sentAt.toISOString(),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    })
    .select("id")
    .maybeSingle();

  if (error?.code === "23505") return "duplicate";
  if (error || !data) throw new Error(`webchat_ingest_insert_failed: ${error?.message ?? "sem id"}`);
  return (data as { id: string }).id;
}
