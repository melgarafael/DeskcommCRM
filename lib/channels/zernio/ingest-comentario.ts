/**
 * Ingestão do COMENTÁRIO do Instagram: webhook → linha própria → evento do
 * motor (#4075).
 *
 * ─── O que já entrava, e o que mudou ──────────────────────────────────────
 *
 * O webhook do canal social só lia evento de MENSAGEM. `comment.*` não tinha
 * leitor: `parseZernioInbound` devolvia `null`, `ingestSocialInbound` respondia
 * `evento_de_outra_conta_ou_sem_interesse` e a rota devolvia 200 — o comentário
 * do cliente era descartado com carimbo de normalidade. Nenhum evento nascia,
 * logo nenhuma automação podia disparar.
 *
 * ─── Por que uma TABELA, e não só o `event_log` ───────────────────────────
 *
 * O evento é o gatilho; a linha é o FATO. Sem `channel_comments` o comentário
 * só existiria dentro de um payload de evento que o dreno apaga, e não haveria
 * como responder "quem comentou o quê no post X" nem provar que a reentrega do
 * provedor não virou duas ações.
 *
 * ─── Idempotência: o índice único é a trava ───────────────────────────────
 *
 * O provedor reentrega o mesmo evento quando não recebe 200. A chave é
 * `(organization_id, provider, external_id)` — e o evento só nasce quando a
 * linha é de fato INSERIDA. Reentrega não gera linha, não gera evento e não
 * dispara ação. É o mesmo contrato de `messages.external_id` na ingestão de
 * mensagem, e não um `if` olhando o relógio.
 *
 * ─── O contato é o MESMO da DM ────────────────────────────────────────────
 *
 * A âncora é a identidade social que o canal já usa
 * (`<plataforma>:<conta>:<autor>`, ver `upsertSocialContact`). Reusar a função
 * — em vez de escrever a resolução aqui — é o que faz quem comentou e depois
 * chamou no direct ser UMA ficha só.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { PLATAFORMA_DO_COMENTARIO, parseZernioComment, type ZernioComment } from "./comentario";
import { upsertSocialContact } from "./ingest";

export interface ZernioCommentIngestResult {
  status: "ingested" | "duplicate" | "ignored";
  reason?: string;
  commentId?: string;
  contactId?: string;
}

/** O nome do provedor na linha — o mesmo de `channel_sessions.provider`. */
const PROVIDER = "zernio_social";

/**
 * Grava um comentário já autenticado pela rota.
 *
 * Recebe a organização e a sessão RESOLVIDAS pela rota: este módulo não
 * descobre de quem é o webhook, só escreve o que já se sabe de quem é.
 */
export async function ingestZernioComment(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    channelSessionId: string;
    payload: unknown;
    /** Conta da sessão — reserva quando o payload não traz `account.id`. */
    accountId?: string | null;
  },
): Promise<ZernioCommentIngestResult> {
  const comentario = parseZernioComment(input.payload);
  if (!comentario) return { status: "ignored", reason: "evento_sem_interesse" };

  // Responder o próprio post volta pelo mesmo webhook. Sem esta guarda a regra
  // responderia a si mesma, e o laço só pararia na cota do provedor.
  if (comentario.fromSelf) {
    return { status: "ignored", reason: "comentario_do_proprio_perfil" };
  }

  const conta = comentario.accountId ?? input.accountId ?? null;
  const identidade = `${PLATAFORMA_DO_COMENTARIO}:${conta ?? ""}:${comentario.authorId}`;
  const contactId = await upsertSocialContact(
    admin,
    input.organizationId,
    identidade,
    comentario.authorName,
  );

  const { data: inseridas, error } = await admin
    .from("channel_comments")
    .upsert(
      {
        organization_id: input.organizationId,
        channel_session_id: input.channelSessionId,
        provider: PROVIDER,
        platform: comentario.platform,
        external_id: comentario.externalId,
        post_id: comentario.postId,
        author_id: comentario.authorId,
        author_username: comentario.authorUsername,
        author_name: comentario.authorName,
        text: comentario.text,
        contact_id: contactId,
        comment_created_at: comentario.createdAt,
      },
      { onConflict: "organization_id,provider,external_id", ignoreDuplicates: true },
    )
    .select("id");

  if (error) throw new Error("comment_insert_failed");

  // Conflito engolido: a linha já existia, então ESTA entrega não é fato novo.
  if (((inseridas as { id: string }[] | null) ?? []).length === 0) {
    return { status: "duplicate", commentId: comentario.externalId, contactId };
  }

  await emitirEventoDoComentario(admin, {
    organizationId: input.organizationId,
    channelSessionId: input.channelSessionId,
    comentario,
    contactId,
  });

  return { status: "ingested", commentId: comentario.externalId, contactId };
}

/**
 * O evento que o motor consome. `device`-free e idêntico ao do canal: o
 * `channel_session_id` no payload é o que faz `canalDoEventoDesativado` pular
 * o comentário de um canal que o operador desligou (#2329).
 */
async function emitirEventoDoComentario(
  admin: SupabaseClient,
  p: {
    organizationId: string;
    channelSessionId: string;
    comentario: ZernioComment;
    contactId: string;
  },
): Promise<void> {
  const { error } = await admin.rpc("emit_event", {
    p_event_type: "instagram.comment",
    p_entity_kind: "contact",
    p_entity_id: p.contactId,
    p_payload: {
      channel_session_id: p.channelSessionId,
      comment_id: p.comentario.externalId,
      post_id: p.comentario.postId,
      platform: p.comentario.platform,
      text: p.comentario.text,
      author_id: p.comentario.authorId,
      author_username: p.comentario.authorUsername,
      contact_id: p.contactId,
      comment_created_at: p.comentario.createdAt,
    },
    p_metadata: { origem: "zernio_social.comentario" },
    p_organization_id: p.organizationId,
  });
  if (error) {
    // A linha JÁ está gravada e o comentário não se perde; o que se perde é o
    // GATILHO. Derrubar a ingestão aqui faria o provedor reentregar para
    // sempre — e a reentrega encontraria a linha existente, devolvendo
    // `duplicate` sem nunca emitir. Rastro no log, então, é o desfecho honesto.
    logger.error("[instagram.comment] a emissão do evento falhou", {
      organization_id: p.organizationId,
      comment_id: p.comentario.externalId,
      detail: error.message,
    });
  }
}
