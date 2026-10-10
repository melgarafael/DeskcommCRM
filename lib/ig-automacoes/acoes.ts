/**
 * Executores de ações do motor de automação do Instagram.
 *
 * Cada ação corresponde a um `tipo` dentro do array `acoes` de uma
 * `ig_automation_flow`. O executor recebe o contexto do evento e executa o
 * side-effect correspondente.
 *
 * ── Princípios ────────────────────────────────────────────────────────────────
 * - Cada ação é IDEMPOTENTE sempre que possível (flags `dm_enviada`, etc.)
 * - Falha de uma ação não impede as seguintes — log + continua
 * - Nenhuma ação faz HTTP dentro de um webhook handler — essas ações são chamadas
 *   pelo WORKER (event_log drain), nunca durante a entrega do webhook
 * - organization_id vem SEMPRE do contexto, nunca de qualquer campo do payload
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";

export interface AcaoCtx {
  /** ID interno do comentário em ig_comment_events */
  commentEventId: string;
  organizationId: string;
  /** Sessão do canal Instagram Zernio (para enviar DM via Zernio) */
  channelSessionId: string | null;
  /** Instagram ID do autor do comentário */
  fromInstagramId: string;
  /** @username do autor (para resposta de comentário) */
  fromUsername: string | null;
  /** Texto do comentário original */
  textoComentario: string | null;
  /** ID do post/media onde o comentário ocorreu */
  mediaId: string | null;
  /** ID do comentário no Instagram (para responder ao comentário) */
  instagramCommentId: string;
  /** ID do flow acionado */
  flowId: string;
}

export type AcaoConfig = Record<string, unknown>;

export interface ResultadoAcao {
  tipo: string;
  status: "ok" | "skipped" | "error";
  detail?: string;
}

// ── Executor: enviar_dm ────────────────────────────────────────────────────────

/**
 * Envia DM para o autor do comentário via Zernio Social (canal Instagram).
 *
 * Requer `channel_session_id` — se não houver sessão configurada, pula com log.
 * Idempotente via flag `dm_enviada` na linha do comentário.
 */
async function executarEnviarDm(
  db: SupabaseClient,
  ctx: AcaoCtx,
  config: AcaoConfig,
): Promise<ResultadoAcao> {
  const tipo = "enviar_dm";

  // Verificar se DM já foi enviada (idempotência)
  const { data: evento } = await db
    .from("ig_comment_events")
    .select("dm_enviada")
    .eq("id", ctx.commentEventId)
    .single();

  if (evento?.dm_enviada) {
    return { tipo, status: "skipped", detail: "dm_ja_enviada" };
  }

  if (!ctx.channelSessionId) {
    logger.warn("[ig-acoes] enviar_dm: sem channel_session_id", {
      commentEventId: ctx.commentEventId,
      organizationId: ctx.organizationId,
    });
    return { tipo, status: "skipped", detail: "sem_channel_session" };
  }

  const texto = typeof config.texto === "string" ? config.texto : null;
  if (!texto) {
    return { tipo, status: "error", detail: "texto_ausente" };
  }

  // Substituições de template
  const textoFinal = texto
    .replace(/\{\{username\}\}/gi, ctx.fromUsername ?? "")
    .replace(/\{\{comentario\}\}/gi, ctx.textoComentario ?? "");

  // Emitir evento para o canal Zernio enviar a DM
  // O worker de canal consome `ig.dm_outbound` e despacha via Zernio API
  const { error } = await db.from("event_log").insert({
    organization_id: ctx.organizationId,
    event_type: "ig.dm_outbound",
    entity_kind: "ig_comment_events",
    entity_id: ctx.commentEventId,
    payload: {
      channel_session_id: ctx.channelSessionId,
      to_instagram_id: ctx.fromInstagramId,
      texto: textoFinal,
      flow_id: ctx.flowId,
    },
  });

  if (error) {
    logger.error("[ig-acoes] enviar_dm: erro ao emitir evento", {
      error: error.message,
      commentEventId: ctx.commentEventId,
    });
    return { tipo, status: "error", detail: error.message };
  }

  // Marcar DM como agendada
  await db
    .from("ig_comment_events")
    .update({ dm_enviada: true, dm_enviada_at: new Date().toISOString() })
    .eq("id", ctx.commentEventId)
    .eq("organization_id", ctx.organizationId);

  return { tipo, status: "ok" };
}

// ── Executor: responder_comentario ────────────────────────────────────────────

/**
 * Responde ao comentário publicamente via Instagram Graph API.
 *
 * Idempotente via flag `respondido_em_comentario`.
 */
async function executarResponderComentario(
  db: SupabaseClient,
  ctx: AcaoCtx,
  config: AcaoConfig,
): Promise<ResultadoAcao> {
  const tipo = "responder_comentario";

  const { data: evento } = await db
    .from("ig_comment_events")
    .select("respondido_em_comentario")
    .eq("id", ctx.commentEventId)
    .single();

  if (evento?.respondido_em_comentario) {
    return { tipo, status: "skipped", detail: "ja_respondido" };
  }

  const texto = typeof config.texto === "string" ? config.texto : null;
  if (!texto) return { tipo, status: "error", detail: "texto_ausente" };

  const textoFinal = texto
    .replace(/\{\{username\}\}/gi, `@${ctx.fromUsername ?? ""}`)
    .replace(/\{\{comentario\}\}/gi, ctx.textoComentario ?? "");

  // Emitir evento para responder ao comentário via Graph API
  const { error } = await db.from("event_log").insert({
    organization_id: ctx.organizationId,
    event_type: "ig.comment_reply_outbound",
    entity_kind: "ig_comment_events",
    entity_id: ctx.commentEventId,
    payload: {
      instagram_comment_id: ctx.instagramCommentId,
      media_id: ctx.mediaId,
      texto: textoFinal,
      flow_id: ctx.flowId,
    },
  });

  if (error) {
    return { tipo, status: "error", detail: error.message };
  }

  await db
    .from("ig_comment_events")
    .update({
      respondido_em_comentario: true,
      resposta_comentario_at: new Date().toISOString(),
    })
    .eq("id", ctx.commentEventId)
    .eq("organization_id", ctx.organizationId);

  return { tipo, status: "ok" };
}

// ── Executor: add_etiqueta ────────────────────────────────────────────────────

/**
 * Adiciona etiqueta ao contato correspondente ao comentador.
 *
 * Resolve o contato pelo `from_instagram_id`. Se não existir contato, pula.
 * Se o contato existe mas ainda não tem a etiqueta, adiciona.
 */
async function executarAddEtiqueta(
  db: SupabaseClient,
  ctx: AcaoCtx,
  config: AcaoConfig,
): Promise<ResultadoAcao> {
  const tipo = "add_etiqueta";
  const etiqueta = typeof config.etiqueta === "string" ? config.etiqueta.trim() : null;
  if (!etiqueta) return { tipo, status: "error", detail: "etiqueta_ausente" };

  // Buscar contato pelo instagram_id (campo de canal social)
  const { data: contato } = await db
    .from("contacts")
    .select("id, tags")
    .eq("organization_id", ctx.organizationId)
    .eq("instagram_id", ctx.fromInstagramId)
    .maybeSingle();

  if (!contato) {
    return { tipo, status: "skipped", detail: "contato_nao_encontrado" };
  }

  const tagsAtuais: string[] = Array.isArray(contato.tags) ? contato.tags : [];
  if (tagsAtuais.includes(etiqueta)) {
    return { tipo, status: "skipped", detail: "etiqueta_ja_presente" };
  }

  const { error } = await db
    .from("contacts")
    .update({ tags: [...tagsAtuais, etiqueta] })
    .eq("id", contato.id)
    .eq("organization_id", ctx.organizationId);

  if (error) return { tipo, status: "error", detail: error.message };
  return { tipo, status: "ok" };
}

// ── Executor: criar_contato ────────────────────────────────────────────────────

/**
 * Cria (ou encontra) o contato para o autor do comentário.
 *
 * Upsert pelo `instagram_id`. Se o contato já existe, pula sem erro.
 * Opcionalmente adiciona ao funil político configurado.
 */
async function executarCriarContato(
  db: SupabaseClient,
  ctx: AcaoCtx,
  config: AcaoConfig,
): Promise<ResultadoAcao> {
  const tipo = "criar_contato";

  // Verificar se já existe
  const { data: existente } = await db
    .from("contacts")
    .select("id")
    .eq("organization_id", ctx.organizationId)
    .eq("instagram_id", ctx.fromInstagramId)
    .maybeSingle();

  if (existente) {
    return { tipo, status: "skipped", detail: "contato_ja_existe" };
  }

  const nome = ctx.fromUsername ? `@${ctx.fromUsername}` : `IG ${ctx.fromInstagramId}`;

  const { data: novoContato, error } = await db
    .from("contacts")
    .insert({
      organization_id: ctx.organizationId,
      name: nome,
      instagram_id: ctx.fromInstagramId,
      origem: "ig_comentario",
      tags: [],
    })
    .select("id")
    .single();

  if (error) return { tipo, status: "error", detail: error.message };

  // Se há pipeline_id configurado, adicionar ao funil
  const pipelineId = typeof config.pipeline_id === "string" ? config.pipeline_id : null;
  if (pipelineId && novoContato?.id) {
    const { data: primeiraEtapa } = await db
      .from("crm_stages")
      .select("id")
      .eq("organization_id", ctx.organizationId)
      .eq("pipeline_id", pipelineId)
      .order("position", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (primeiraEtapa) {
      await db.from("crm_leads").insert({
        organization_id: ctx.organizationId,
        pipeline_id: pipelineId,
        stage_id: primeiraEtapa.id,
        contact_id: novoContato.id,
        title: nome,
      });
    }
  }

  return { tipo, status: "ok" };
}

// ── Executor: notificar_equipe ─────────────────────────────────────────────────

/**
 * Cria aviso na Central para que um membro da equipe veja o comentário.
 *
 * Abre um `agent_inbox_items` do tipo `ig_comentario` para o assignee configurado
 * (ou para toda a equipe se não houver assignee específico).
 */
async function executarNotificarEquipe(
  db: SupabaseClient,
  ctx: AcaoCtx,
  config: AcaoConfig,
): Promise<ResultadoAcao> {
  const tipo = "notificar_equipe";

  const mensagem =
    typeof config.mensagem === "string"
      ? config.mensagem
      : `Novo comentário de @${ctx.fromUsername ?? ctx.fromInstagramId}`;

  const { error } = await db.from("agent_inbox_items").insert({
    organization_id: ctx.organizationId,
    kind: "ig_comentario",
    title: mensagem,
    body: ctx.textoComentario ?? "",
    metadata: {
      comment_event_id: ctx.commentEventId,
      from_instagram_id: ctx.fromInstagramId,
      from_username: ctx.fromUsername,
      flow_id: ctx.flowId,
      media_id: ctx.mediaId,
    },
    assignee_user_id: typeof config.assignee_user_id === "string" ? config.assignee_user_id : null,
  });

  if (error) return { tipo, status: "error", detail: error.message };
  return { tipo, status: "ok" };
}

// ── Executor: add_funil_politico ───────────────────────────────────────────────

/**
 * Adiciona o contato ao funil político (Simpatizante → Apoiador → Embaixador).
 *
 * Ação especializada para o GIP War Room 2.0: move o contato pelo funil
 * político com base no `nivel` configurado.
 */
async function executarAddFunilPolitico(
  db: SupabaseClient,
  ctx: AcaoCtx,
  config: AcaoConfig,
): Promise<ResultadoAcao> {
  const tipo = "add_funil_politico";
  const nivel = typeof config.nivel === "string" ? config.nivel : "Simpatizante";

  // Primeiro garante que o contato existe
  await executarCriarContato(db, ctx, {});

  // Adiciona a etiqueta do nível político
  const resultEtiqueta = await executarAddEtiqueta(db, ctx, { etiqueta: nivel });
  if (resultEtiqueta.status === "error") return { tipo, status: "error", detail: resultEtiqueta.detail };

  return { tipo, status: "ok" };
}

// ── Registry de executores ─────────────────────────────────────────────────────

type Executor = (
  db: SupabaseClient,
  ctx: AcaoCtx,
  config: AcaoConfig,
) => Promise<ResultadoAcao>;

const EXECUTORES: Record<string, Executor> = {
  enviar_dm: executarEnviarDm,
  responder_comentario: executarResponderComentario,
  add_etiqueta: executarAddEtiqueta,
  criar_contato: executarCriarContato,
  notificar_equipe: executarNotificarEquipe,
  add_funil_politico: executarAddFunilPolitico,
};

// ── Executor principal ──────────────────────────────────────────────────────────

/**
 * Executa TODAS as ações de um flow, em ordem, coletando resultados.
 *
 * Falha de uma ação nunca impede as seguintes — o princípio é best-effort
 * com registro completo de cada resultado.
 */
export async function executarAcoes(
  db: SupabaseClient,
  ctx: AcaoCtx,
  acoes: AcaoConfig[],
): Promise<ResultadoAcao[]> {
  const resultados: ResultadoAcao[] = [];

  for (const acao of acoes) {
    const tipo = typeof acao.tipo === "string" ? acao.tipo : "desconhecido";
    const executor = EXECUTORES[tipo];

    if (!executor) {
      logger.warn("[ig-acoes] tipo de ação desconhecido", { tipo, flowId: ctx.flowId });
      resultados.push({ tipo, status: "skipped", detail: "tipo_desconhecido" });
      continue;
    }

    try {
      const resultado = await executor(db, ctx, acao);
      resultados.push(resultado);
      logger.info("[ig-acoes] ação executada", {
        tipo,
        status: resultado.status,
        commentEventId: ctx.commentEventId,
        organizationId: ctx.organizationId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("[ig-acoes] ação lançou exceção", {
        tipo,
        error: msg,
        commentEventId: ctx.commentEventId,
      });
      resultados.push({ tipo, status: "error", detail: msg });
    }
  }

  return resultados;
}
