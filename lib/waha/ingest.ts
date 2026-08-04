/**
 * lib/waha/ingest.ts — pipeline de ingestão WAHA compartilhado pelos dois route
 * handlers de webhook (`/waha` global e `/waha/[token]` per-tenant).
 *
 * Fonte única da verdade para: parse de identidade WhatsApp, resolução de
 * contato/conversa e persistência de mensagem. Resolução é ATÔMICA via RPC
 * (fn_upsert_wa_contact / fn_upsert_wa_conversation) — o padrão check-then-act
 * antigo criava um contato/conversa novo a cada mensagem porque o WAHA NOWEB
 * emite `message` E `message.any` para a mesma mensagem (corrida). Ver migration
 * 0027 para o modelo de identidade canônica.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { audit } from "@/lib/audit";
import type { createAdminClient } from "@/lib/supabase/admin";
import { ackToStatus } from "@/lib/types/messaging";
import { bareWaMessageId, chatIdFromWaMessageId } from "@/lib/waha/message-id";

type Admin = ReturnType<typeof createAdminClient>;

interface Session {
  id: string;
  organization_id: string;
}

export interface WahaPayload {
  id?: string;
  from?: string;
  to?: string;
  fromMe?: boolean;
  body?: string;
  type?: string;
  hasMedia?: boolean;
  ack?: number;
  ackName?: string;
  participant?: string;
  author?: string;
  status?: string;
  timestamp?: number;
  mediaUrl?: string;
  mimetype?: string;
  /** WAHA >= 2026.x (NOWEB): mídia vem aninhada em payload.media. */
  media?: { url?: string | null; mimetype?: string | null; filename?: string | null } | null;
  _data?: {
    notifyName?: string;
    pushName?: string;
    /** NOWEB: o conteúdo real (imageMessage, stickerMessage, …) — fonte do tipo. */
    message?: Record<string, unknown>;
  } & Record<string, unknown>;
}

export interface WahaEnvelope {
  event?: string;
  session?: string;
  payload?: WahaPayload;
}

export type ChatIdentity =
  | { kind: "phone"; phone: string; lid: null }
  | { kind: "lid"; phone: null; lid: string } // lid = somente dígitos
  | { kind: "group"; phone: null; lid: null }
  | { kind: "unknown"; phone: null; lid: null };

/**
 * Resolve um chatId WAHA em identidade canônica:
 *  - `{number}@c.us` | `@s.whatsapp.net` -> phone E.164 ("+55...")
 *  - `{lid}@lid` -> lid (somente dígitos; número protegido pelo WhatsApp)
 *  - `@g.us` -> group (skip binding CRM — descarte ESPERADO, por doutrina)
 *  - qualquer outra coisa -> unknown (descarte que DEIXA RASTRO)
 *
 * A quarta variante existe porque este `return` final classificava tudo o que
 * não reconhecia como "grupo", e o ingest descarta grupo: "não sei ler isto"
 * virava "descarta calado" — a mesma família do defeito que sumia com a mensagem
 * digitada no celular (PR #108), inclusive o mesmo sintoma de webhook devolvendo
 * 200 sem erro. `@newsletter` e `@broadcast` já existem em produção e caíam
 * aqui; o próximo formato do WhatsApp reproduziria o caso inteiro.
 *
 * Grupo e desconhecido têm o MESMO desfecho (não viram contato) e naturezas
 * opostas: um é decisão de produto, o outro é buraco de conhecimento. Só o
 * segundo é anomalia, então só ele emite evento.
 */
export function parseChatId(chatId: string): ChatIdentity {
  if (chatId.endsWith("@g.us")) return { kind: "group", phone: null, lid: null };
  if (chatId.endsWith("@lid")) {
    return { kind: "lid", phone: null, lid: chatId.replace(/@.*$/, "") };
  }
  if (chatId.endsWith("@c.us") || chatId.endsWith("@s.whatsapp.net")) {
    const digits = chatId.replace(/@.*$/, "").replace(/^\+/, "");
    return { kind: "phone", phone: "+" + digits, lid: null };
  }
  return { kind: "unknown", phone: null, lid: null };
}

/** Só estes dois viram contato no CRM — ver a guarda de `upsertContact`. */
function ehEnderecavel(parsed: ChatIdentity): boolean {
  return parsed.kind === "phone" || parsed.kind === "lid";
}

/**
 * O SUFIXO responde "que formato é este?"; o resto identifica uma pessoa.
 *
 * Registro operacional não é cópia de dado de contato — mesma linha de
 * `markConversation`, que deliberadamente não copia o texto da mensagem. Sem
 * isso, o log de diagnóstico vira depósito de número de telefone.
 */
function sufixoDeChatId(chatId: string): string {
  const at = chatId.lastIndexOf("@");
  if (at !== -1) return chatId.slice(at);
  return chatId === "" ? "(vazio)" : "(sem @)";
}

/**
 * Um chatId que não sabemos endereçar é ANOMALIA — tem que ser contável.
 *
 * `select count(*) from event_log where event_type = 'whatsapp.chat_id_not_recognized'`
 * responde "o WhatsApp mudou de formato e estamos perdendo mensagem?", que antes
 * não tinha como ser respondido: o descarte não deixava nada para trás.
 */
async function avisarChatNaoReconhecido(
  admin: Admin,
  organizationId: string,
  sessionId: string,
  chatId: string,
  direction: "inbound" | "outbound",
): Promise<void> {
  const { error } = await admin.rpc("emit_event" as never, {
    p_event_type: "whatsapp.chat_id_not_recognized",
    p_entity_kind: "channel_session",
    p_entity_id: sessionId,
    p_payload: { sufixo: sufixoDeChatId(chatId), direction },
    p_metadata: { severity: "warn" },
    p_organization_id: organizationId,
  } as never);
  if (error) {
    console.error("[waha.ingest] o aviso de chat não reconhecido também falhou", error.message);
  }
}

const STOP_RX = /\b(STOP|PARAR|SAIR|UNSUBSCRIBE)\b/i;

export function verifyHmacSha512(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha512", secret).update(rawBody, "utf8").digest("hex");
  const got = signatureHeader.replace(/^sha512=/i, "").trim();
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function previewFromMessage(p: WahaPayload): string {
  if (p.body) return p.body.slice(0, 280);
  const t = resolveMessageType(p);
  return t !== "text" ? `[${t}]` : "";
}

/** URL da mídia: WAHA novo (payload.media.url) com fallback legado (payload.mediaUrl). */
export function mediaUrlOf(p: WahaPayload): string | null {
  return p.mediaUrl ?? p.media?.url ?? null;
}

/** MIME da mídia: idem (payload.media.mimetype é o campo do NOWEB atual). */
export function mediaMimeOf(p: WahaPayload): string | null {
  return p.mimetype ?? p.media?.mimetype ?? null;
}

/**
 * Mapeia o `type` cru do WAHA NOWEB para o vocabulário de messages.type do CRM
 * (check constraint messages_type_check). WAHA usa `chat` p/ texto, `ptt` p/
 * áudio de voz, `vcard` p/ contato, etc. Sem esse mapa o INSERT viola a
 * constraint e a mensagem some. O type cru fica em metadata.raw_type.
 */
const WA_TYPE_MAP: Record<string, string> = {
  chat: "text",
  text: "text",
  ptt: "audio",
  audio: "audio",
  image: "image",
  video: "video",
  document: "document",
  sticker: "sticker",
  location: "location",
  vcard: "contact",
  contact: "contact",
  multi_vcard: "contact",
  reaction: "reaction",
};

function mapWahaMessageType(raw: string | undefined): string {
  if (!raw) return "text";
  // Fallback "text": só chegamos ao insert com body/mídia presente (guarda acima),
  // então tratar tipo desconhecido como texto não perde a mensagem.
  return WA_TYPE_MAP[raw.toLowerCase()] ?? "text";
}

/**
 * NOWEB (WAHA 2026.x) não envia `type` no payload — o tipo real está nas
 * chaves de `_data.message` (imageMessage, stickerMessage, …). Ordem de
 * resolução: `type` explícito → chave do message → prefixo do MIME → text.
 */
const NOWEB_MESSAGE_KEY_TYPE: Record<string, string> = {
  stickerMessage: "sticker",
  imageMessage: "image",
  videoMessage: "video",
  ptvMessage: "video", // video note (bolinha)
  audioMessage: "audio",
  documentMessage: "document",
  documentWithCaptionMessage: "document",
};

export function resolveMessageType(p: WahaPayload): string {
  if (p.type) return mapWahaMessageType(p.type);
  const msg = p._data?.message;
  if (msg && typeof msg === "object") {
    for (const [key, mapped] of Object.entries(NOWEB_MESSAGE_KEY_TYPE)) {
      if (key in msg) return mapped;
    }
  }
  const mime = mediaMimeOf(p);
  if (mime) {
    if (mime === "image/webp") return "sticker";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "document";
  }
  return "text";
}

function notifyNameOf(p: WahaPayload): string | null {
  return p._data?.notifyName ?? p._data?.pushName ?? null;
}

/**
 * Upsert atômico de contato pela identidade canônica. Retorna null se a
 * identidade for de grupo ou a RPC falhar.
 */
async function upsertContact(
  admin: Admin,
  orgId: string,
  parsed: ChatIdentity,
  chatId: string,
  notifyName: string | null,
): Promise<string | null> {
  // ALLOWLIST, não denylist — e a diferença aqui não é estilo.
  //
  // `fn_upsert_wa_contact` NÃO valida `p_kind`, e `contacts.wa_identity` é coluna
  // GERADA que só produz `phone:`/`lid:`; qualquer outro kind a deixa NULL. Como
  // o `on conflict` da RPC é `(organization_id, wa_identity) where wa_identity is
  // not null`, uma linha NULL nunca conflita — nasceria UM CONTATO NOVO A CADA
  // WEBHOOK, que é exatamente o anti-pattern que a migration 0027 veio matar.
  //
  // Com `kind === "group"` (a forma antiga), acrescentar uma variante à união
  // abria esse buraco em silêncio: o TS não reclama de um `===` que deixou de
  // cobrir todos os casos. Perguntar quem PODE passar falha fechado sozinho.
  //
  // ⚠️ SEGUNDA CAMADA, SEM COBERTURA POSSÍVEL — e isto está escrito porque medi:
  // trocar esta linha de volta pela denylist deixa a suíte inteira VERDE (35/35,
  // typecheck 0). Os dois chamadores já barram o não-endereçável antes de chegar
  // aqui, então nenhum teste consegue alcançá-la; é defesa em profundidade na
  // fronteira com uma RPC que não valida nada. Quem mexer aqui não vai ser
  // avisado por teste nenhum — só por este comentário.
  if (!ehEnderecavel(parsed)) return null;
  const { data, error } = await admin.rpc("fn_upsert_wa_contact" as never, {
    p_org: orgId,
    p_kind: parsed.kind,
    p_phone: parsed.kind === "phone" ? parsed.phone : null,
    p_lid: parsed.kind === "lid" ? parsed.lid : null,
    p_chat_id: chatId,
    p_notify: notifyName,
  } as never);
  if (error) {
    console.error("[waha.ingest] fn_upsert_wa_contact failed", error.message);
    return null;
  }
  return (data as string) ?? null;
}

async function upsertConversation(
  admin: Admin,
  orgId: string,
  contactId: string,
  sessionId: string,
): Promise<string | null> {
  const { data, error } = await admin.rpc("fn_upsert_wa_conversation" as never, {
    p_org: orgId,
    p_contact: contactId,
    p_session: sessionId,
  } as never);
  if (error) {
    console.error("[waha.ingest] fn_upsert_wa_conversation failed", error.message);
    return null;
  }
  return (data as string) ?? null;
}

/**
 * Carimba a conversa com a mensagem que acabou de entrar.
 *
 * ⚠️ FALHA BAIXO, MAS CONTA — e a diferença entre as duas coisas é o motivo
 * desta função existir com corpo próprio. A mensagem JÁ foi inserida quando
 * chegamos aqui; bloquear a ingestão porque o carimbo falhou deixaria o
 * histórico refém de uma coluna derivada. Então não se bloqueia.
 *
 * Mas `console.error` sozinho não é "falhar baixo": ele **não bloqueia e também
 * não conta** (anti-pattern nº 14 do CLAUDE.md, e a mesma doutrina já escrita em
 * `lib/leads/activity-write-failure.ts`). Log de servidor sem destino não vira
 * alerta de ninguém — e o efeito prático é que "a RPC falha às vezes" nunca sai
 * de OPINIÃO para NÚMERO. Em 25/07 isso custou caro: a suspeita de que esta
 * chamada falhava foi levada a sério por horas, e não havia como medi-la porque
 * cada falha tinha sumido no log de um processo que já não existia.
 *
 * O evento é o que torna a pergunta respondível: `select count(*) from event_log
 * where event_type = 'whatsapp.conversation_mark_failed'`.
 */
async function markConversation(
  admin: Admin,
  organizationId: string,
  convId: string,
  direction: "inbound" | "outbound",
  preview: string,
  at: string,
): Promise<void> {
  const { error } = await admin.rpc("fn_mark_conversation_message" as never, {
    p_conv: convId,
    p_direction: direction,
    p_preview: preview,
    p_at: at,
  } as never);
  if (!error) return;

  const { error: erroAviso } = await admin.rpc("emit_event" as never, {
    p_event_type: "whatsapp.conversation_mark_failed",
    p_entity_kind: "conversation",
    p_entity_id: convId,
    // O preview NÃO entra no payload: ele é o texto da mensagem do cliente, e
    // isto é registro operacional, não cópia de conteúdo. O que se precisa
    // saber para agir é qual conversa, que sentido, e o erro.
    p_payload: { direction, erro: error.message },
    p_metadata: { severity: "warn" },
    p_organization_id: organizationId,
  } as never);

  if (erroAviso) {
    // Segunda linha de defesa: o próprio canal de aviso caiu. Aqui o log do
    // processo é o que sobra — é para ESTE caso que ele existe, não como rotina.
    console.error("[waha.ingest] o carimbo falhou E o aviso também", {
      conversa: convId,
      erro: error.message,
      aviso: erroAviso.message,
    });
  }
}

/**
 * Mensagem recebida (fromMe=false). Contato = remetente (`from`).
 */
async function handleInbound(
  admin: Admin,
  session: Session,
  p: WahaPayload,
  requestId: string,
): Promise<void> {
  const chatId = p.from ?? "";
  const parsed = parseChatId(chatId);
  if (parsed.kind === "group") return; // grupos não fazem binding CRM
  if (!p.id) return;
  // WAHA emite eventos vazios p/ status/read-receipt/presence — não viram mensagem.
  if (!p.body && !mediaUrlOf(p) && !p.hasMedia) return;
  // Daqui para baixo era para ser uma mensagem de verdade: se o chat não é
  // endereçável, PERDEMOS uma — e isso precisa ser contável. O aviso fica depois
  // das guardas acima de propósito; antes delas, todo evento de presença viraria
  // um registro, e log que enche sozinho é log que ninguém lê.
  if (!ehEnderecavel(parsed)) {
    await avisarChatNaoReconhecido(admin, session.organization_id, session.id, chatId, "inbound");
    return;
  }

  const contactId = await upsertContact(admin, session.organization_id, parsed, chatId, notifyNameOf(p));
  if (!contactId) return;
  const conversationId = await upsertConversation(admin, session.organization_id, contactId, session.id);
  if (!conversationId) return;

  const now = new Date().toISOString();
  const { data: insertedMessage, error: insertErr } = await admin
    .from("messages")
    .insert({
      organization_id: session.organization_id,
      conversation_id: conversationId,
      channel_session_id: session.id,
      contact_id: contactId,
      external_id: p.id,
      type: resolveMessageType(p),
      direction: "inbound",
      status: "delivered",
      ack: p.ack ?? null,
      body: p.body ?? null,
      media_url: mediaUrlOf(p),
      media_mime: mediaMimeOf(p),
      sent_via: "external_device",
      sent_at: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : now,
      delivered_at: now,
      metadata: { raw_type: p.type, ack_name: p.ackName },
    })
    .select("id")
    .maybeSingle();

  // Idempotência: 23505 = unique (organization_id, external_id) já ingerido.
  if (insertErr && insertErr.code !== "23505") {
    console.error("[waha.ingest] message insert failed", insertErr.message);
    return;
  }
  if (insertErr?.code === "23505") return;

  await markConversation(admin, session.organization_id, conversationId, "inbound", previewFromMessage(p), now);

  if (p.body && STOP_RX.test(p.body)) {
    await admin
      .from("contacts")
      .update({ is_blocked: true, blocked_reason: "stop_keyword", blocked_at: now })
      .eq("id", contactId);
    await audit({
      action: "contact.blocked",
      organizationId: session.organization_id,
      resourceType: "contact",
      requestId,
      metadata: { reason: "stop_keyword", contact_id: contactId },
    });
  }

  await audit({
    action: "message.received",
    organizationId: session.organization_id,
    resourceType: "message",
    requestId,
    metadata: { conversation_id: conversationId, type: p.type, external_id: p.id },
  });

  // Dispara o agent-dispatcher worker (fire-and-forget; falha não quebra o 200).
  if (insertedMessage?.id) {
    const inboundMessageId = insertedMessage.id;
    admin
      .rpc("emit_event" as never, {
        p_event_type: "ai_agent.dispatch_requested",
        p_entity_kind: "message",
        p_entity_id: inboundMessageId,
        p_payload: {
          organization_id: session.organization_id,
          conversation_id: conversationId,
          contact_id: contactId,
          channel_session_id: session.id,
          inbound_message_id: inboundMessageId,
        },
        p_metadata: { source: "waha_webhook", request_id: requestId },
        p_organization_id: session.organization_id,
      } as never)
      .then(({ error }) => {
        if (error) console.error("[waha.ingest] emit dispatch_requested failed", error.message);
      });

    admin
      .rpc("emit_event" as never, {
        p_event_type: "message.received",
        p_entity_kind: "message",
        p_entity_id: inboundMessageId,
        p_payload: {
          conversation_id: conversationId,
          contact_id: contactId,
          channel_session_id: session.id,
          body_preview: (p.body ?? "").slice(0, 280),
        },
        p_metadata: { source: "waha_webhook", request_id: requestId },
        p_organization_id: session.organization_id,
      } as never)
      .then(({ error }) => {
        if (error) console.error("[waha.ingest] emit message.received failed", error.message);
      });

    if (mediaUrlOf(p)) {
      admin
        .rpc("emit_event" as never, {
          p_event_type: "media.persist_requested",
          p_entity_kind: "message",
          p_entity_id: inboundMessageId,
          p_payload: { message_id: inboundMessageId, conversation_id: conversationId },
          p_metadata: { source: "waha_webhook", request_id: requestId },
          p_organization_id: session.organization_id,
        } as never)
        .then(({ error }) => {
          if (error) console.error("[waha.ingest] emit media.persist_requested failed", error.message);
        });
    }
  }
}

/**
 * fromMe=true: operador respondeu direto do WhatsApp dele (não pelo composer).
 * Contato = destinatário (`to`). `from` é o próprio número do operador — nunca
 * vira contato. Registrado como outbound p/ o operador ver o histórico completo.
 */
async function handleOutboundFromUserPhone(
  admin: Admin,
  session: Session,
  p: WahaPayload,
  requestId: string,
): Promise<void> {
  // De onde sai o chat, em ordem de confiança:
  //   1. `to`  — o WEBJS manda; é o destinatário explícito.
  //   2. o id  — `{fromMe}_{chatId}_{bareId}` carrega o chat em qualquer engine.
  //   3. `from`— no NOWEB, mensagem fromMe traz o CHAT em `from` (não o número
  //              do operador, como acontece no WEBJS).
  //
  // O NOWEB (engine padrão do kit) **não manda `to`** aqui. Com `p.to ?? ""` o
  // chatId ficava vazio e a guarda abaixo descartava a mensagem em silêncio —
  // toda mensagem que o dono digitava no celular sumia do CRM, enquanto as
  // enviadas pelo composer e pela IA apareciam (essas nascem no banco antes do
  // webhook, então não dependiam deste caminho). O sintoma era "respondi pelo
  // celular e o CRM não mostra", sem nenhum erro em log: o webhook devolvia 200.
  const chatId = p.to ?? chatIdFromWaMessageId(p.id ?? "") ?? p.from ?? "";
  const parsed = parseChatId(chatId);
  if (parsed.kind === "group") return;
  if (!p.id) return;
  if (!p.body && !mediaUrlOf(p) && !p.hasMedia) return;
  // Idem inbound. Aqui o caso que mais dói é o chatId vazio: é literalmente o
  // defeito do #108 — mensagem que o dono digitou no celular sem `to`, sem id
  // composto e sem `from`. Se voltar a acontecer por um formato novo, agora sai
  // um evento em vez de silêncio.
  //
  // A metade `!chatId` da guarda anterior sai daqui junto: ela era condição
  // MORTA (varri 12 valores de `to` e nenhum a disparava, porque o único falsy
  // já era classificado como grupo uma linha acima) e voltaria a viver como
  // duplicata desta guarda, descartando calado justamente o caso que se quer ver.
  if (!ehEnderecavel(parsed)) {
    await avisarChatNaoReconhecido(admin, session.organization_id, session.id, chatId, "outbound");
    return;
  }

  // ECO DO PRÓPRIO ENVIO — não duplicar.
  //
  // Toda mensagem que o CRM manda (composer ou IA) volta pelo webhook como
  // `fromMe=true`. O dedup por `external_id` NÃO pega esse caso, porque os dois
  // lados gravam formas diferentes do mesmo id: o envio grava o id "bare"
  // (`3EB0…`) e o webhook chega com o composto (`true_<chat>_3EB0…`). São
  // strings distintas, então o unique não dispara e nasce uma segunda linha —
  // a mesma frase aparecendo duas vezes na conversa.
  //
  // Antes isto não aparecia por acidente: sem `to`, esta função voltava cedo e
  // o eco era descartado junto com as mensagens legítimas do celular. Ao
  // consertar aquele caminho, a duplicação ficou exposta.
  //
  // Mesmo par de candidatos que o `handleAck` usa — cobre NOWEB (bare) e WEBJS
  // (full) sem depender do engine.
  const bare = bareWaMessageId(p.id);
  const idCandidates = bare === p.id ? [p.id] : [p.id, bare];
  const { data: jaRegistrada } = await admin
    .from("messages")
    .select("id")
    .eq("organization_id", session.organization_id)
    .in("external_id", idCandidates)
    .limit(1)
    .maybeSingle();
  if (jaRegistrada) return; // nasceu no envio; quem atualiza o status é o ack

  // fromMe: o pushName do payload é o do OPERADOR, não do destinatário —
  // repassá-lo batizaria o contato do cliente com o nome da loja (e o
  // coalesce do fn_upsert_wa_contact congelaria o nome errado).
  const contactId = await upsertContact(admin, session.organization_id, parsed, chatId, null);
  if (!contactId) return;
  const conversationId = await upsertConversation(admin, session.organization_id, contactId, session.id);
  if (!conversationId) return;

  const now = new Date().toISOString();
  const { data: insertedOutbound, error: insertErr } = await admin
    .from("messages")
    .insert({
      organization_id: session.organization_id,
      conversation_id: conversationId,
      channel_session_id: session.id,
      contact_id: contactId,
      external_id: p.id,
      type: resolveMessageType(p),
      direction: "outbound",
      status: "sent",
      ack: p.ack ?? null,
      body: p.body ?? null,
      media_url: mediaUrlOf(p),
      media_mime: mediaMimeOf(p),
      sent_via: "external_device",
      sent_at: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : now,
      metadata: { raw_type: p.type, fromMe: true },
    })
    .select("id")
    .maybeSingle();
  if (insertErr && insertErr.code !== "23505") {
    console.error("[waha.ingest] outbound insert failed", insertErr.message);
    return;
  }
  if (insertErr?.code === "23505") return;

  await markConversation(admin, session.organization_id, conversationId, "outbound", previewFromMessage(p), now);

  await audit({
    action: "message.sent",
    organizationId: session.organization_id,
    resourceType: "message",
    requestId,
    metadata: { conversation_id: conversationId, type: p.type, external_id: p.id, from_user_phone: true },
  });

  if (insertedOutbound?.id && mediaUrlOf(p)) {
    admin
      .rpc("emit_event" as never, {
        p_event_type: "media.persist_requested",
        p_entity_kind: "message",
        p_entity_id: insertedOutbound.id,
        p_payload: { message_id: insertedOutbound.id, conversation_id: conversationId },
        p_metadata: { source: "waha_webhook", request_id: requestId },
        p_organization_id: session.organization_id,
      } as never)
      .then(({ error }) => {
        if (error) console.error("[waha.ingest] emit media.persist_requested failed", error.message);
      });
  }
}

async function handleAck(admin: Admin, session: Session, p: WahaPayload): Promise<void> {
  if (!p.id) return;
  const ack = p.ack ?? 0;
  const status = ackToStatus(ack);
  const now = new Date().toISOString();

  const update: Record<string, unknown> = { ack, status };
  if (ack >= 2) update.delivered_at = now;
  if (ack >= 3) update.read_at = now;

  // O ack do WAHA 2026.x vem como `{fromMe}_{chatId}_{bareId}`. O NOWEB grava
  // `external_id` = bareId (id interno), o WEBJS grava o `_serialized` completo.
  // Casar as duas formas cobre ambos os engines sem tocar no external_id de
  // inbound (que é full e sustenta o dedup 23505).
  const bare = bareWaMessageId(p.id);
  const candidates = bare === p.id ? [p.id] : [p.id, bare];
  await admin
    .from("messages")
    .update(update)
    .eq("organization_id", session.organization_id)
    .in("external_id", candidates);
}

interface SessionStatusRow extends Session {
  is_warmup_complete: boolean | null;
  warmup_started_at: string | null;
}

async function handleSessionStatus(
  admin: Admin,
  session: SessionStatusRow,
  p: WahaPayload,
): Promise<void> {
  const status = (p.status ?? "").toUpperCase() || null;
  if (!status) return;
  const allowed = new Set(["STARTING", "SCAN_QR_CODE", "WORKING", "STOPPED", "FAILED"]);
  if (!allowed.has(status)) return;
  const now = new Date().toISOString();

  const update: Record<string, unknown> = { status, last_status_change_at: now };
  if (status === "WORKING" && session.warmup_started_at && !session.is_warmup_complete) {
    update.is_warmup_complete = true;
    update.warmup_completed_at = now;
  }
  await admin.from("channel_sessions").update(update).eq("id", session.id);
}

/**
 * Roteador único de eventos WAHA. Os dois route handlers convergem aqui após
 * resolver a sessão e validar HMAC.
 */
export async function dispatchWahaEvent(
  admin: Admin,
  session: SessionStatusRow,
  envelope: WahaEnvelope,
  requestId: string,
): Promise<void> {
  const eventType = envelope.event ?? "unknown";
  const payload = envelope.payload ?? {};

  if (eventType === "message" || eventType === "message.any") {
    if (payload.fromMe) {
      await handleOutboundFromUserPhone(admin, session, payload, requestId);
    } else {
      await handleInbound(admin, session, payload, requestId);
    }
  } else if (eventType === "message.ack") {
    await handleAck(admin, session, payload);
  } else if (eventType === "session.status" || eventType === "state.change") {
    await handleSessionStatus(admin, session, payload);
  }
}
