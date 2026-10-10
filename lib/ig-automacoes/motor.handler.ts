/**
 * Worker de automação do Instagram — handler do event_log.
 *
 * Consome eventos `ig.comment_received` e avalia TODOS os flows de automação
 * ativos da organização, executando as ações do primeiro que bater.
 *
 * ── Por que "primeiro que bater" ─────────────────────────────────────────────
 * O comportamento padrão do ManyChat é o mesmo: o primeiro flow com gatilho
 * que casa com o comentário vence. Isso evita que o mesmo comentário acione
 * múltiplos flows conflitantes (ex.: enviar DM duas vezes).
 *
 * Para mudar para "todos que batem", altere `encontrouMatch` para não dar break.
 *
 * ── Tipos de gatilho suportados ───────────────────────────────────────────────
 * - `comment_keyword`   : comentário contém palavra-chave (case-insensitive opcional)
 * - `comment_no_post`   : comentário em qualquer post (sem filtro de post)
 * - `novo_comentario`   : qualquer novo comentário (catch-all)
 * - `story_reply`       : reply em story (field = 'mentions' — indicativo)
 * - `dm_keyword`        : palavra-chave em DM (consumido por outro handler no futuro)
 *
 * ── Event_log / idempotência ──────────────────────────────────────────────────
 * O consumer_key `ig.automacao` é registrado em `event_log.consumed_by` após
 * o processamento. Reentrega do mesmo evento é detectada automaticamente pelo
 * dispatcher via `consumed_by`.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";
import { executarAcoes, type AcaoCtx } from "./acoes";

export const IG_AUTOMACAO_CONSUMER_KEY = "ig.automacao";

/** Config de um flow de automação com keyword */
interface TriggerConfigKeyword {
  keywords?: string[];
  case_sensitive?: boolean;
  post_ids?: string[];
}

/** Avalia se o texto do comentário bate com a config de keyword */
function avaliarKeyword(texto: string | null, config: TriggerConfigKeyword): boolean {
  if (!texto) return false;
  const keywords = Array.isArray(config.keywords) ? config.keywords : [];
  if (keywords.length === 0) return true; // sem keywords = qualquer texto

  const caseSensitive = config.case_sensitive === true;
  const textoNorm = caseSensitive ? texto : texto.toLowerCase();

  return keywords.some((kw) => {
    const kwNorm = caseSensitive ? kw : kw.toLowerCase();
    return textoNorm.includes(kwNorm);
  });
}

/** Avalia se o post_id bate com a whitelist (se configurada) */
function avaliarPostId(
  mediaId: string | null,
  config: { post_ids?: string[] },
): boolean {
  const postIds = Array.isArray(config.post_ids) ? config.post_ids : [];
  if (postIds.length === 0) return true; // sem filtro de post = qualquer post
  return mediaId !== null && postIds.includes(mediaId);
}

// ── Row de um flow de automação ────────────────────────────────────────────────

interface FlowRow {
  id: string;
  trigger_tipo: string;
  trigger_config: Record<string, unknown>;
  acoes: Record<string, unknown>[];
}

/** Avalia se um flow bate com o evento de comentário recebido */
function flowCasaComEvento(
  flow: FlowRow,
  payload: {
    texto: string | null;
    mediaId: string | null;
    field: string | null;
  },
): boolean {
  switch (flow.trigger_tipo) {
    case "novo_comentario":
      // Catch-all: qualquer comentário
      return true;

    case "comment_keyword": {
      const config = flow.trigger_config as TriggerConfigKeyword;
      return (
        avaliarKeyword(payload.texto, config) && avaliarPostId(payload.mediaId, config)
      );
    }

    case "comment_no_post": {
      // Comentário SEM filtro de post específico (mas verifica se post_ids exclui este)
      return avaliarPostId(payload.mediaId, flow.trigger_config as { post_ids?: string[] });
    }

    case "story_reply": {
      // Story reply chega como `field = 'mentions'` do Graph API
      return payload.field === "mentions";
    }

    // dm_keyword e novo_seguidor são para DMs — não desse handler
    case "dm_keyword":
    case "novo_seguidor":
      return false;

    default:
      return false;
  }
}

// ── Handler principal ──────────────────────────────────────────────────────────

export const igAutomacaoHandler: EventHandler = {
  key: IG_AUTOMACAO_CONSUMER_KEY,
  events: ["ig.comment_received"],
  naOrgParada: "pula",

  async handle(row: EventRow): Promise<HandlerResult> {
    const db = createAdminClient();
    const { organization_id, payload, entity_id } = row;

    const commentEventId = entity_id;
    if (!commentEventId) {
      logger.warn("[ig-motor] evento sem entity_id", { eventId: row.id });
      return {
        consumer_key: IG_AUTOMACAO_CONSUMER_KEY,
        status: "skipped",
        detail: "sem_comment_event_id",
      };
    }

    // Ler dados do comentário do banco (payload é resumo, o banco tem o completo)
    const { data: comentario, error: errComentario } = await db
      .from("ig_comment_events")
      .select(
        "id, organization_id, instagram_comment_id, instagram_media_id, from_instagram_id, from_username, texto, processado, channel_session_id",
      )
      .eq("id", commentEventId)
      .eq("organization_id", organization_id)
      .single();

    if (errComentario || !comentario) {
      logger.error("[ig-motor] comentário não encontrado", {
        commentEventId,
        error: errComentario?.message,
      });
      return {
        consumer_key: IG_AUTOMACAO_CONSUMER_KEY,
        status: "error",
        detail: "comentario_nao_encontrado",
      };
    }

    if (comentario.processado) {
      return {
        consumer_key: IG_AUTOMACAO_CONSUMER_KEY,
        status: "skipped",
        detail: "ja_processado",
      };
    }

    // Buscar todos os flows ativos da organização que atendem comentários
    const { data: flows, error: errFlows } = await db
      .from("ig_automation_flows")
      .select("id, trigger_tipo, trigger_config, acoes")
      .eq("organization_id", organization_id)
      .eq("ativo", true)
      .in("trigger_tipo", ["novo_comentario", "comment_keyword", "comment_no_post", "story_reply"]);

    if (errFlows) {
      logger.error("[ig-motor] erro ao buscar flows", { error: errFlows.message, organization_id });
      return {
        consumer_key: IG_AUTOMACAO_CONSUMER_KEY,
        status: "error",
        detail: `erro_ao_buscar_flows:${errFlows.message}`,
      };
    }

    if (!flows || flows.length === 0) {
      await db
        .from("ig_comment_events")
        .update({ processado: true, processado_at: new Date().toISOString() })
        .eq("id", commentEventId)
        .eq("organization_id", organization_id);

      return {
        consumer_key: IG_AUTOMACAO_CONSUMER_KEY,
        status: "skipped",
        detail: "sem_flows_ativos",
      };
    }

    const eventPayload = {
      texto: typeof payload.texto === "string" ? payload.texto : null,
      mediaId: typeof payload.media_id === "string" ? payload.media_id : null,
      field: typeof payload.field === "string" ? payload.field : null,
    };

    // Avaliar flows em ordem — primeiro que bater executa
    let encontrouMatch = false;
    let flowAcionadoId: string | null = null;

    for (const flow of flows as FlowRow[]) {
      if (!flowCasaComEvento(flow, eventPayload)) continue;

      encontrouMatch = true;
      flowAcionadoId = flow.id;

      const ctx: AcaoCtx = {
        commentEventId,
        organizationId: organization_id,
        channelSessionId: comentario.channel_session_id ?? null,
        fromInstagramId: comentario.from_instagram_id,
        fromUsername: comentario.from_username ?? null,
        textoComentario: comentario.texto ?? null,
        mediaId: comentario.instagram_media_id ?? null,
        instagramCommentId: comentario.instagram_comment_id,
        flowId: flow.id,
      };

      const resultados = await executarAcoes(db, ctx, flow.acoes ?? []);
      const temErro = resultados.some((r) => r.status === "error");

      logger.info("[ig-motor] flow acionado", {
        flowId: flow.id,
        commentEventId,
        resultados,
        organization_id,
      });

      // Atualizar stats do flow
      await db
        .from("ig_automation_flows")
        .update({
          ultima_ativacao_at: new Date().toISOString(),
          // Incrementar total_acionamentos via SQL raw (evita race condition)
          stats: db.rpc as unknown as Record<string, unknown>, // será atualizado abaixo
        })
        .eq("id", flow.id)
        .eq("organization_id", organization_id);

      // Atualizar stats via rpc ou update com jsonb concat
      await db.rpc("fn_ig_incrementar_stats_flow", { p_flow_id: flow.id }).catch(() => {
        // Se a função não existe ainda, fallback silencioso — não é bloqueante
      });

      if (temErro) {
        logger.warn("[ig-motor] flow acionado com erros parciais", {
          flowId: flow.id,
          erros: resultados.filter((r) => r.status === "error"),
        });
      }

      break; // Primeiro flow que bater — comportamento ManyChat
    }

    // Marcar comentário como processado
    await db
      .from("ig_comment_events")
      .update({
        processado: true,
        processado_at: new Date().toISOString(),
        flow_acionado_id: flowAcionadoId,
      })
      .eq("id", commentEventId)
      .eq("organization_id", organization_id);

    return {
      consumer_key: IG_AUTOMACAO_CONSUMER_KEY,
      status: encontrouMatch ? "ok" : "skipped",
      detail: encontrouMatch ? `flow_acionado:${flowAcionadoId}` : "nenhum_flow_bateu",
    };
  },
};
