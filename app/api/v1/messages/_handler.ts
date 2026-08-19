/**
 * Core handlers para messages (list + send).
 *
 * Reusados por:
 *  - POST /api/v1/messages (sendMessageHandler)
 *  - GET  /api/v1/conversations/[id]/messages (listMessagesHandler)
 *  - MCP tools (S-13.04)
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { Actor, HandlerCtx } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  DEFAULT_CHANNEL_PROVIDER,
  getAdapter,
  resolveSessionRef,
  type ChannelSessionRef,
} from "@/lib/channels";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { conferirDefinicao } from "@/lib/channels/conferir-definicao";
import { isMediaPathOwnedBy } from "@/lib/messaging/media/upload-validation";
import type { ListMessagesQuery, SendMessageInput } from "@/lib/schemas";
import { sendTemplateForSession } from "@/lib/channels/meta/send-template-for-session";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Message } from "@/lib/types/messaging";

type SB = SupabaseClient;

/**
 * Remove a linha que o WEBHOOK criou para a mensagem que ESTE envio acabou de
 * mandar — o "eco do próprio envio".
 *
 * A janela: a linha do envio nasce antes de falar com o canal (`queued`,
 * `external_id` NULL) e só recebe o id depois que o adapter volta. Todo envio
 * retorna pelo webhook como `fromMe=true`; o eco que chega nesse intervalo não
 * acha nada para casar e vira uma segunda linha com a mesma frase.
 *
 * POR QUE AQUI E NÃO NO WEBHOOK. Lá, a única coisa disponível para casar seria a
 * própria linha `queued` — e ela não carrega nada que a identifique como sendo
 * daquela mensagem. Casar por ela é casar por "existe um envio em voo nesta
 * conversa", o que vale para o eco e também para uma mensagem legítima que o
 * atendente digitou no celular enquanto o envio estava em voo: medido, esperado
 * 2 mensagens e obtido 1, com a do celular descartada. Seria o defeito do #108
 * de volta — e permanente, porque nada tira uma linha de `queued`.
 *
 * ATUALIZAÇÃO (issue #129): o cron `recover-stuck-messages` passou a existir
 * (`app/api/v1/cron/recover-stuck-messages/route.ts`), mas ele cobre `sending`,
 * não `queued` — e a diferença é deliberada. `queued` é estado de espera com
 * DONO: o agent-engine reagenda o job (`SEND_QUEUED_RETRY_MS`, 5 min por
 * padrão) enquanto a sessão do canal não está WORKING, e o watchdog redirige.
 * Um cron marcando `queued` como falha depois de 5 min brigaria com essa
 * retentativa e perderia mensagem que ia sair. `sending` não tem dono nenhum —
 * é ali que a linha morre em silêncio.
 *
 * Aqui não há ambiguidade: o canal acabou de devolver o id EXATO da mensagem que
 * mandamos. Casa por id, nunca por proximidade.
 *
 * QUAIS formas o mesmo id pode ter é conhecimento do CANAL, não de quem envia —
 * então os candidatos chegam prontos, de `adapter.echoExternalIds`. Um canal
 * simétrico não implementa o método e o chamador cai no próprio `externalId`.
 *
 * O escopo é deliberadamente estreito — mesma conversa e só o que nasceu de
 * `external_device`. O bare pode colidir entre mensagens diferentes (garantia do
 * WhatsApp, não nossa); restringir mantém o estrago de uma colisão dentro do
 * único lugar onde ela seria de fato a nossa mensagem, e impede de apagar linha
 * do próprio CRM.
 */
async function removerEcoDoProprioEnvio(
  supabase: SB,
  organizationId: string,
  conversationId: string,
  minhaLinhaId: string,
  externalId: string | null,
  candidatos: string[],
): Promise<void> {
  if (!externalId || candidatos.length === 0) return;

  // BLINDADO DE PROPÓSITO. Esta chamada roda dentro do `try` do envio, e a
  // mensagem JÁ SAIU quando chegamos aqui: deixar uma exceção subir faria o
  // `catch` de baixo marcar como `failed` uma mensagem que o cliente recebeu —
  // trocar uma duplicata visível por um status mentiroso. O pior caso aceitável
  // é não conseguir remover, que é exatamente o mundo de antes desta função.
  try {
    const { error } = await supabase
      .from("messages")
      .delete()
      .eq("organization_id", organizationId)
      .eq("conversation_id", conversationId)
      .eq("sent_via", "external_device")
      .in("external_id", candidatos)
      // ⚠️ SEGUNDA CAMADA, SEM COBERTURA POSSÍVEL — escrito porque medi: trocar
      // este `neq` por um que nunca casa deixa a suíte VERDE. O filtro de
      // `sent_via` acima já exclui a linha deste envio (que nasce `user`/`ai`,
      // nunca `external_device`), então nenhum teste alcança esta cláusula.
      // Fica porque o desfecho que ela impede é o pior que esta função poderia
      // produzir: apagar a própria mensagem que acabou de ser entregue. Quem
      // mexer no filtro de cima não vai ser avisado por teste nenhum.
      .neq("id", minhaLinhaId);
    if (error) console.error("[messages.send] não consegui remover o eco do próprio envio", error.message);
  } catch (err) {
    console.error("[messages.send] a remoção do eco lançou", err instanceof Error ? err.message : err);
  }
}

const MSG_COLS =
  "id, organization_id, conversation_id, channel_session_id, contact_id, external_id, type, direction, status, ack, error_code, error_message, body, media_url, media_mime, media_size_bytes, media_storage_path, sent_via, sent_by_user_id, sent_at, delivered_at, read_at, metadata, edited_at, revoked_at, created_at";

function actorAuditPayload(actor: Actor): {
  actorUserId: string | null;
  metadataActor: Record<string, unknown>;
} {
  if (actor.type === "user") {
    return { actorUserId: actor.id, metadataActor: { actor_type: "user" } };
  }
  return {
    actorUserId: null,
    metadataActor: {
      actor_type: actor.type,
      actor_id: actor.id,
      ...(actor.type === "ai_agent" && actor.api_token_id
        ? { actor_api_token_id: actor.api_token_id }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

interface MsgCursorPayload {
  sent_at: string;
  id: string;
}

function encodeMsgCursor(p: MsgCursorPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}
function decodeMsgCursor(raw: string): MsgCursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as MsgCursorPayload;
    if (typeof parsed.id !== "string" || typeof parsed.sent_at !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface ListMessagesResult {
  messages: Message[];
  cursor: string | null;
  has_more: boolean;
}

export async function listMessagesHandler(
  supabase: SB,
  ctx: HandlerCtx,
  conversationId: string,
  q: ListMessagesQuery,
): Promise<ListMessagesResult> {
  // A CONSULTA VAI DO MAIS NOVO PARA O MAIS VELHO — de propósito.
  //
  // Antes era `ascending: true`: a primeira página trazia as `limit` mensagens
  // MAIS ANTIGAS da conversa, e as novas ficavam atrás do cursor. Numa conversa
  // com mais mensagens que o limite (50, o padrão), o atendente simplesmente
  // NÃO VIA o que acabou de chegar — a tela travava num ponto do passado e não
  // se mexia mais, por mais que o cliente escrevesse.
  //
  // Medido numa instalação real: conversa com 64 mensagens: a tela parava na
  // #50 (16:15) e as 14 seguintes (16:20 → 16:48) eram invisíveis, embora
  // gravadas. E piora com o uso: quanto mais se conversa com alguém, mais
  // mensagens novas somem. Num CRM de WhatsApp, é a conversa mais importante
  // que fica pior.
  //
  // Chat lê de baixo para cima: o padrão certo é buscar as ÚLTIMAS N e paginar
  // para trás ao rolar. O cursor, portanto, passa a andar para o passado
  // (`lt`), e não mais para o futuro.
  let query = supabase
    .from("messages")
    .select(MSG_COLS)
    .eq("conversation_id", conversationId)
    .eq("organization_id", ctx.organization_id)
    .order("sent_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(q.limit + 1);

  if (q.cursor) {
    const c = decodeMsgCursor(q.cursor);
    if (!c) {
      throw new ApiError(400, "invalid_cursor", undefined, ctx.requestId, "Cursor inválido.");
    }
    query = query.or(`sent_at.lt.${c.sent_at},and(sent_at.eq.${c.sent_at},id.lt.${c.id})`);
  }

  const { data, error } = await query;
  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  }

  const rows = (data ?? []) as unknown as Message[];
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;

  // Em ordem decrescente, o ÚLTIMO da página é o mais antigo dela — é dele que
  // sai o cursor, porque a próxima página é a que vem ANTES no tempo.
  const oldest = page[page.length - 1];
  const cursor =
    hasMore && oldest ? encodeMsgCursor({ sent_at: oldest.sent_at, id: oldest.id }) : null;

  // A RESPOSTA continua cronológica (antigo → novo), igual a antes: o consumidor
  // renderiza de cima para baixo sem mudar nada. O que mudou foi QUAIS mensagens
  // entram na página, não a ordem em que saem.
  return { messages: page.slice().reverse(), cursor, has_more: hasMore };
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

function previewFrom(input: {
  body?: string;
  media_url?: string;
  media_storage_path?: string;
  type?: string;
}): string {
  if (input.body) return input.body.slice(0, 280);
  if (input.media_url || input.media_storage_path) return `[${input.type ?? "media"}]`;
  return "";
}

/**
 * Atendente respondeu manualmente → IA fica quieta nesta conversa por uma janela curta,
 * renovada a cada mensagem humana (sliding window). Sem isto, a IA só "parecia" quieta
 * por coincidência de timing (nenhum turno novo disparado) e voltava a responder junto
 * com o humano assim que o cliente mandava a próxima mensagem — `isLeadInHandoff`
 * (lib/agent-engine/agent/human-handoff.ts) só olhava `force_human`/`bot_silenced_until`,
 * e nenhum envio manual tocava nenhum dos dois.
 */
const HUMAN_REPLY_SILENCE_MS = 5 * 60 * 1000;

/**
 * Postgres 'infinity' (handoff permanente — regex/tool/orquestrador) chega do PostgREST
 * como o literal texto "infinity", que `new Date(...)` não parseia. Nunca encurtar isso
 * para uma janela de 5min: se já está travado pra sempre, este helper não mexe.
 */
function extendBotSilence(current: string | null, now: string): string | undefined {
  if (current === "infinity") return undefined;
  const candidate = new Date(new Date(now).getTime() + HUMAN_REPLY_SILENCE_MS);
  if (current && new Date(current) >= candidate) return undefined;
  return candidate.toISOString();
}

export async function sendMessageHandler(
  supabase: SB,
  ctx: HandlerCtx,
  input: SendMessageInput,
): Promise<Message> {
  // `archived_at` entra pelo helper tolerante porque este é O caminho de saída do
  // sistema inteiro (UI, automação, MCP e o agente passam por aqui): num clone que
  // subiu o código sem a migration 0106, pedir a coluna direto derrubaria TODO
  // envio com 42703. Sem a coluna, nada está arquivado — e a consulta sem ela é a
  // consulta certa (ver lib/channels/archived).
  const convSelect = (comArchived: boolean) =>
    `id, organization_id, contact_id, channel_session_id, is_group, group_chat_id, bot_silenced_until, provider_conversation_id, contacts:contact_id(phone_number, wa_identity, wa_lid, is_blocked), channel_sessions:channel_session_id(${CHANNEL_SESSION_REF_COLUMNS}, status${comArchived ? `, ${ARCHIVED_AT}` : ""})`;
  const { data: conv, error: convErr } = await queryTolerantToMissingArchived(
    () => supabase.from("conversations").select(convSelect(true)).eq("id", input.conversation_id).maybeSingle(),
    () => supabase.from("conversations").select(convSelect(false)).eq("id", input.conversation_id).maybeSingle(),
  );

  if (convErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, convErr.message);
  }
  if (!conv) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Conversa não encontrada.");
  }

  type Joined = {
    id: string;
    organization_id: string;
    contact_id: string;
    channel_session_id: string;
    is_group: boolean;
    group_chat_id: string | null;
    bot_silenced_until: string | null;
    /** Thread do provider, quando ele endereça por thread própria (migration 0132). */
    provider_conversation_id: string | null;
    contacts: {
      phone_number: string | null;
      wa_identity: string | null;
      wa_lid: string | null;
      is_blocked: boolean;
    } | null;
    channel_sessions: (ChannelSessionRef & { status: string; archived_at?: string | null }) | null;
  };
  const c = conv as unknown as Joined;

  if (c.contacts?.is_blocked) {
    throw new ApiError(
      403,
      "forbidden",
      undefined,
      ctx.requestId,
      "Contato bloqueou o atendimento.",
    );
  }

  if (input.media_storage_path && !isMediaPathOwnedBy(input.media_storage_path, c.organization_id, c.id)) {
    throw new ApiError(
      422,
      "invalid_media_path",
      undefined,
      ctx.requestId,
      "media_storage_path fora da conversa.",
    );
  }

  const now = new Date().toISOString();
  const insertRow = {
    organization_id: c.organization_id,
    conversation_id: c.id,
    channel_session_id: c.channel_session_id,
    contact_id: c.contact_id,
    type: input.type,
    direction: "outbound" as const,
    status: "queued",
    body: input.body ?? null,
    media_url: input.media_url ?? null,
    media_mime: input.media_mime ?? null,
    media_storage_path: input.media_storage_path ?? null,
    media_size_bytes: input.media_size_bytes ?? null,
    sent_via: ctx.actor.type !== "user" ? ("ai" as const) : ("user" as const),
    sent_by_user_id: ctx.actor.type === "user" ? ctx.actor.id : null,
    sent_at: now,
    metadata: {
      ...(input.metadata ?? {}),
      ...(ctx.actor.type === "ai_agent" ? { ai_actor_id: ctx.actor.id } : {}),
    },
  };

  const { data: created, error: insErr } = await supabase
    .from("messages")
    .insert(insertRow)
    .select(MSG_COLS)
    .single();

  if (insErr || !created) {
    throw new ApiError(
      500,
      "internal_error",
      undefined,
      ctx.requestId,
      insErr?.message ?? "insert_failed",
    );
  }
  let message = created as unknown as Message;

  // O canal vem da SESSÃO (migration 0087), não de um literal. O fallback só
  // alcança o caso em que o embed não trouxe a sessão — impossível hoje
  // (`conversations.channel_session_id` é NOT NULL com FK ON DELETE RESTRICT),
  // e ainda assim mantido para não trocar o desfecho desse ramo defensivo.
  const adapter = getAdapter(c.channel_sessions?.provider ?? DEFAULT_CHANNEL_PROVIDER);
  const chatId = adapter.resolveRecipient({
    isGroup: c.is_group,
    groupChatId: c.group_chat_id,
    phoneNumber: c.contacts?.phone_number,
    waIdentity: c.contacts?.wa_identity,
    waLid: c.contacts?.wa_lid,
  });

  if (c.channel_sessions?.archived_at) {
    // Canal ARQUIVADO = canal excluído pelo usuário: a sessão já foi deslogada e
    // removida do transporte, e a credencial do canal oficial já foi revogada. É a
    // promessa da migration 0106 ("não é mais elegível para envio") virando
    // comportamento.
    //
    // `failed` e não `queued` de propósito: fila implica "vai sair quando der", e
    // por este canal não vai sair nunca. Falha com código é o que aparece na tela
    // e é o que o ledger do agente lê como desfecho TERMINAL — em `queued` o
    // follow-up ficaria retentando contra um número que não existe mais.
    // Vem ANTES de `isConfigured`: um canal excluído não espera configuração.
    const { data: updated } = await supabase
      .from("messages")
      .update({
        status: "failed",
        error_code: "channel_archived",
        error_message: "Este número foi excluído da Central de Conexões.",
      })
      .eq("id", message.id)
      .select(MSG_COLS)
      .maybeSingle();
    if (updated) message = updated as unknown as Message;
  } else if (!adapter.isConfigured()) {
    const { data: updated } = await supabase
      .from("messages")
      .update({
        metadata: { ...(message.metadata ?? {}), queued_reason: adapter.codes.notConfigured },
      })
      .eq("id", message.id)
      .select(MSG_COLS)
      .maybeSingle();
    if (updated) message = updated as unknown as Message;
  } else if (!chatId) {
    const { data: updated } = await supabase
      .from("messages")
      .update({
        status: "failed",
        error_code: "missing_phone_number",
        error_message: "Contato sem telefone para envio WhatsApp.",
      })
      .eq("id", message.id)
      .select(MSG_COLS)
      .maybeSingle();
    if (updated) message = updated as unknown as Message;
  } else if (!c.channel_sessions || c.channel_sessions.status !== "WORKING") {
    const { data: updated } = await supabase
      .from("messages")
      .update({
        metadata: {
          ...(message.metadata ?? {}),
          queued_reason: "channel_session_not_working",
        },
      })
      .eq("id", message.id)
      .select(MSG_COLS)
      .maybeSingle();
    if (updated) message = updated as unknown as Message;
  } else if (message.sent_via === "ai") {
    const { data: updated } = await supabase
      .from("messages")
      .update({
        metadata: {
          ...(message.metadata ?? {}),
          queued_reason: "outbox_pacing",
        },
      })
      .eq("id", message.id)
      .select(MSG_COLS)
      .maybeSingle();
    if (updated) message = updated as unknown as Message;
  } else {
    try {
      // O que separa mídia de texto é a presença de `media` no envelope — o
      // adapter preserva o mesmo branch (e a mesma mensagem de erro de cada
      // método) do outro lado do seam.
      let externalId: string | null;
      if (input.type === "template") {
        // Template é caminho próprio: não passa pelo `adapter.send` (que fala em
        // texto/mídia) porque o payload da plataforma é outro — e porque o envio
        // exige checar o contrato ANTES de sair (bind vigente, valores completos),
        // coisa que só faz sentido para template.
        //
        // Mas quem SABE falar template é o adapter, quando sabe. Antes disto a
        // linha de baixo era o único caminho, e ela lê `META_PHONE_NUMBER_ID` e
        // `META_SYSTEM_USER_TOKEN` do ambiente: template de QUALQUER canal saía
        // pelo número da Meta, com o token da Meta. Para o canal intermediado
        // isso não é falha de envio — é a mensagem saindo pelo número ERRADO
        // para o cliente certo, e ninguém percebe porque ela sai.
        // ─── Pré-voo ANTES de escolher transporte ──────────────────────────
        //
        // Vale para os dois caminhos, e é por isso que está aqui e não dentro
        // de um deles: a definição aprovada é contrato da plataforma, não
        // característica do transporte. O caminho de baixo já conferia; o
        // adapter postava direto, e um parâmetro a mais virava `400` cru em vez
        // de "falta o valor {{2}}".
        await conferirDefinicao(supabase, {
          organizationId: ctx.organization_id,
          // A conexão dona da definição: dois números têm modelos diferentes, e
          // conferir a do número errado aprovaria um envio que a plataforma
          // recusa. `null` só em base anterior à 0144.
          channelSessionId: c.channel_session_id ?? null,
          name: input.template_name ?? "",
          language: input.template_language ?? "",
          values: input.template_values ?? {},
        });

        externalId = adapter.sendTemplate
          ? (
              await adapter.sendTemplate({
                sessionRef: resolveSessionRef(c.channel_sessions),
                to: chatId,
                providerConversationId: c.provider_conversation_id,
                name: input.template_name ?? "",
                language: input.template_language ?? "",
                values: input.template_values ?? {},
              })
            ).externalId
          : await sendTemplateForSession(supabase, {
              organizationId: ctx.organization_id,
              to: chatId,
              name: input.template_name ?? "",
              language: input.template_language ?? "",
              values: input.template_values ?? {},
            });
      } else if (input.media_storage_path) {
        // Storage-first: signed URL curta só pro canal baixar (nunca base64).
        const admin = createAdminClient();
        const { data: signed, error: signErr } = await admin.storage
          .from("whatsapp-media")
          .createSignedUrl(input.media_storage_path, 600);
        if (signErr || !signed?.signedUrl) {
          throw new Error(`storage_sign_failed: ${signErr?.message ?? "no_url"}`);
        }
        const filename = input.media_storage_path.split("/").pop() ?? undefined;
        ({ externalId } = await adapter.send({
          sessionRef: resolveSessionRef(c.channel_sessions),
          to: chatId,
          providerConversationId: c.provider_conversation_id,
          kind: input.type,
          media: {
            url: signed.signedUrl,
            mime: input.media_mime ?? "application/octet-stream",
            filename,
            caption: input.body ?? null,
          },
        }));
      } else {
        ({ externalId } = await adapter.send({
          sessionRef: resolveSessionRef(c.channel_sessions),
          to: chatId,
          providerConversationId: c.provider_conversation_id,
          kind: input.type,
          body: input.body ?? "",
        }));
      }
      await removerEcoDoProprioEnvio(
        supabase,
        ctx.organization_id,
        c.id,
        message.id,
        externalId,
        externalId ? (adapter.echoExternalIds?.({ externalId, recipient: chatId }) ?? [externalId]) : [],
      );
      const { data: updated } = await supabase
        .from("messages")
        .update({
          status: "sent",
          external_id: externalId,
          ack: 0,
          // Colunas só do template — é o que responde custo e conformidade de
          // janela depois, sem varrer jsonb.
          ...(input.type === "template"
            ? { template_name: input.template_name, template_language: input.template_language }
            : {}),
        })
        .eq("id", message.id)
        .select(MSG_COLS)
        .maybeSingle();
      if (updated) message = updated as unknown as Message;
    } catch (err) {
      const msg = err instanceof Error ? err.message : adapter.codes.unknownError;
      // `storage_sign_failed` fica literal: é falha do NOSSO Storage, não do
      // canal — a URL assinada é montada antes de qualquer coisa tocar o adapter.
      const code = msg.startsWith("storage_sign_failed")
        ? "storage_sign_failed"
        : adapter.codes.sendFailed;

      // Falta de CREDENCIAL não é falha desta mensagem: é canal ainda não
      // conectado, e o desfecho certo é `queued` — a mesma coisa que o ramo de
      // `!isConfigured()` acima grava. Marcar `failed` mandaria o follow-up
      // desistir de uma mensagem que sai sozinha assim que alguém conectar.
      //
      // Este ramo existe porque nem todo canal consegue responder `isConfigured`
      // com honestidade: quando a credencial mora na SESSÃO (conta conectada
      // pela tela) e não no ambiente, um método SÍNCRONO não tem como saber, e
      // responder "não configurado" travaria em `queued` um canal que funciona.
      // Quem sabe é `send()`, que pode consultar o banco — então ele lança, e a
      // tradução do desfecho acontece aqui.
      if (msg.startsWith(adapter.codes.notConfigured)) {
        const { data: emFila } = await supabase
          .from("messages")
          .update({
            metadata: { ...(message.metadata ?? {}), queued_reason: adapter.codes.notConfigured },
          })
          .eq("id", message.id)
          .select(MSG_COLS)
          .maybeSingle();
        if (emFila) message = emFila as unknown as Message;
        return message;
      }

      const { data: updated } = await supabase
        .from("messages")
        .update({
          status: "failed",
          error_code: code,
          error_message: msg,
        })
        .eq("id", message.id)
        .select(MSG_COLS)
        .maybeSingle();
      if (updated) message = updated as unknown as Message;
    }
  }

  const conversationUpdate: {
    last_outbound_at: string;
    last_message_at: string;
    last_message_preview: string;
    bot_silenced_until?: string;
  } = {
    last_outbound_at: now,
    last_message_at: now,
    last_message_preview: previewFrom({
      body: input.body,
      media_url: input.media_url,
      media_storage_path: input.media_storage_path,
      type: input.type,
    }),
  };
  if (ctx.actor.type === "user") {
    const silenceUntil = extendBotSilence(c.bot_silenced_until, now);
    if (silenceUntil) conversationUpdate.bot_silenced_until = silenceUntil;
  }

  await supabase.from("conversations").update(conversationUpdate).eq("id", c.id);

  const a = actorAuditPayload(ctx.actor);
  await audit({
    action: "message.sent",
    actorUserId: a.actorUserId,
    organizationId: c.organization_id,
    resourceType: "message",
    resourceId: message.id,
    requestId: ctx.requestId,
    metadata: { ...a.metadataActor, status: message.status, type: message.type },
  });

  await supabase
    .rpc("emit_event", {
      p_event_type: "message.sent",
      p_entity_kind: "message",
      p_entity_id: message.id,
      p_payload: { status: message.status, conversation_id: c.id },
      p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
      p_organization_id: c.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[messages.send] emit_event failed", error.message);
    });

  return message;
}
