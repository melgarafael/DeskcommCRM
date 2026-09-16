/**
 * Capacidades de INSTAGRAM — publicar em nome do lead (Spec: feature
 * instagram-publish).
 *
 * Três tools, deliberadamente separadas (nunca uma só que publica direto):
 *
 * 1. `crm_instagram_conectar` — devolve o link de conexão (ou diz que já está
 *    conectado). Sem efeito colateral, sempre seguro de chamar.
 * 2. `crm_instagram_preparar_post` — grava um RASCUNHO (`instagram_pending_posts`,
 *    status='pending'). NÃO publica nada. Existe para o agente mostrar
 *    legenda/hashtags ao lead e pedir confirmação antes de qualquer efeito
 *    público e irreversível.
 * 3. `crm_instagram_confirmar_post` — só esta publica de fato, e só quando
 *    chamada NUM TURNO POSTERIOR (depois que o lead respondeu confirmando).
 *    O prompt do agente é quem decide SE a resposta do lead foi uma
 *    confirmação — mesmo modelo de confiança que `crm_close_human_case` já
 *    usa para decisões que exigem juízo sobre a conversa.
 */
import { z } from "zod";

import { audit } from "@/lib/audit";
import { conexaoAtivaDoLead } from "@/lib/instagram/connections";
import { instagramAppDaOrganizacao, numeroAutorizadoAPublicar } from "@/lib/instagram/apps";
import { enderecoDeConexao } from "@/lib/instagram/config";
import { urlPublicaTemporaria } from "@/lib/instagram/media-publica";
import {
  criarContainer,
  esperarContainerPronto,
  publicarContainer,
  permalinkDoMedia,
} from "@/lib/instagram/publicar";
import type { McpContext, McpToolDefinition } from "../types";

function actorAudit(ctx: McpContext): {
  actorUserId: string | null;
  metadataActor: Record<string, unknown>;
} {
  const actor = ctx.actor;
  if (actor.type === "user") {
    return { actorUserId: actor.id, metadataActor: { actor_type: "user" } };
  }
  return { actorUserId: null, metadataActor: { actor_type: actor.type, actor_id: actor.id } };
}

async function contatoDaConversa(
  ctx: McpContext,
  conversationId: string,
): Promise<string | null> {
  const { data } = await ctx.supabase
    .from("conversations")
    .select("contact_id")
    .eq("id", conversationId)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  return (data?.contact_id as string | undefined) ?? null;
}

/**
 * A trava de "lista de teste" — mesmo raciocínio do pré-go-live do WhatsApp
 * (migration 0268). Lança `instagram_indisponivel_para_este_contato` para
 * QUALQUER contato fora da lista, nas três tools igualmente: enquanto a
 * organização tiver uma lista configurada, ninguém fora dela alcança
 * conectar, preparar OU confirmar — o número do agente é compartilhado, e
 * sem esta trava qualquer lead que mandasse mensagem conseguiria publicar
 * no próprio Instagram dele através do agente.
 */
async function garantirContatoAutorizado(ctx: McpContext, contactId: string): Promise<void> {
  const app = await instagramAppDaOrganizacao(ctx.supabase, ctx.organizationId);
  if (!app) throw new Error("instagram_nao_configurado");

  const { data: contato } = await ctx.supabase
    .from("contacts")
    .select("phone_number")
    .eq("id", contactId)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();

  if (!numeroAutorizadoAPublicar(app, (contato?.phone_number as string | null) ?? null)) {
    throw new Error("instagram_indisponivel_para_este_contato");
  }
}

// ---------------------------------------------------------------------------
// crm_instagram_conectar
// ---------------------------------------------------------------------------

const conectarInputShape = {
  conversation_id: z.string().uuid(),
};

export const crmInstagramConectar: McpToolDefinition<typeof conectarInputShape> = {
  name: "crm_instagram_conectar",
  description:
    "Verifica se o lead desta conversa já conectou o Instagram dele. Se não, devolve um link que o " +
    "agente deve mandar pelo WhatsApp para o lead abrir e autorizar (conta precisa ser Business ou " +
    "Creator). Sem efeito nenhum — só consulta e, no máximo, gera um link.",
  inputSchema: conectarInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const contactId = await contatoDaConversa(ctx, input.conversation_id);
    if (!contactId) throw new Error("conversation_not_found");
    await garantirContatoAutorizado(ctx, contactId);

    const conexao = await conexaoAtivaDoLead(ctx.supabase, ctx.organizationId, contactId);
    if (conexao) {
      return {
        ja_conectado: true,
        username: conexao.igUsername,
      };
    }

    return {
      ja_conectado: false,
      link_de_conexao: enderecoDeConexao(ctx.organizationId, contactId),
    };
  },
};

// ---------------------------------------------------------------------------
// crm_instagram_preparar_post
// ---------------------------------------------------------------------------

const prepararInputShape = {
  conversation_id: z.string().uuid(),
  message_id: z.string().uuid().describe("A mensagem do WhatsApp que trouxe a foto ou o vídeo."),
  destino: z.enum(["feed", "reels", "stories"]),
  caption: z
    .string()
    .max(2200)
    .optional()
    .describe("Obrigatório para feed/reels. Ignorado para stories — o Instagram não aceita legenda em story."),
  hashtags: z
    .array(z.string().min(1).max(60))
    .max(5)
    .optional()
    .describe("Até 5 hashtags, sem o #. Ignorado para stories."),
};

export const crmInstagramPrepararPost: McpToolDefinition<typeof prepararInputShape> = {
  name: "crm_instagram_preparar_post",
  description:
    "Prepara um post do Instagram a partir da foto/vídeo que o lead mandou — feed (foto, com legenda), " +
    "reels (vídeo curto, com legenda) ou stories (foto ou vídeo, SEM legenda — o Instagram não aceita " +
    "legenda em story, então nem pergunte por uma se o destino for stories). NÃO publica nada ainda. Use " +
    "depois de crm_instagram_conectar confirmar que o lead está conectado. Para feed/reels, sempre mostre " +
    "a legenda e as hashtags geradas ao lead; para stories, mostre que vai publicar a mídia sem legenda. " +
    "Peça confirmação explícita antes de chamar crm_instagram_confirmar_post — publicar é irreversível e público.",
  inputSchema: prepararInputShape,
  category: "write",
  // `ai_operator`, não `agent`: não existe rota HTTP equivalente que um
  // atendente humano use pela tela para preparar um post no Instagram de
  // outra pessoa — isto não é "trabalho do dia", é capacidade nova, e o piso
  // mais alto restringe a token de API/humano com papel `agent`, deixando
  // só o runtime do próprio agente publicado alcançar.
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const contactId = await contatoDaConversa(ctx, input.conversation_id);
    if (!contactId) throw new Error("conversation_not_found");
    await garantirContatoAutorizado(ctx, contactId);

    const conexao = await conexaoAtivaDoLead(ctx.supabase, ctx.organizationId, contactId);
    if (!conexao) throw new Error("instagram_nao_conectado");

    const { data: msg } = await ctx.supabase
      .from("messages")
      .select("id, direction, media_storage_path, media_mime")
      .eq("id", input.message_id)
      .eq("conversation_id", input.conversation_id)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();
    if (!msg || msg.direction !== "inbound" || !msg.media_storage_path) {
      throw new Error("mensagem_sem_midia");
    }
    const mime = (msg.media_mime as string | null) ?? "";
    const ehImagem = mime.startsWith("image/");
    const ehVideo = mime.startsWith("video/");
    if (input.destino === "feed" && !ehImagem) throw new Error("feed_exige_imagem");
    if (input.destino === "reels" && !ehVideo) throw new Error("reels_exige_video");
    if (input.destino === "stories" && !ehImagem && !ehVideo) throw new Error("stories_exige_foto_ou_video");

    // Stories não aceita legenda na API do Instagram — nunca grava o texto
    // que o modelo eventualmente mandar para esse destino.
    const ehStories = input.destino === "stories";
    if (!ehStories && !input.caption?.trim()) throw new Error("caption_obrigatoria_para_feed_e_reels");
    const caption = ehStories ? "" : (input.caption ?? "").trim();
    const hashtags = ehStories ? [] : (input.hashtags ?? []);

    const { data: criado, error } = await ctx.supabase
      .from("instagram_pending_posts")
      .insert({
        organization_id: ctx.organizationId,
        contact_id: contactId,
        conversation_id: input.conversation_id,
        source_message_id: input.message_id,
        destino: input.destino,
        caption,
        hashtags,
        status: "pending",
      })
      .select("id")
      .single();
    if (error || !criado) throw new Error("falha_ao_preparar");

    const a = actorAudit(ctx);
    await audit({
      action: "instagram.post_preparado",
      actorUserId: a.actorUserId,
      actorApiTokenId: ctx.apiTokenId,
      organizationId: ctx.organizationId,
      resourceType: "instagram_pending_post",
      resourceId: criado.id,
      requestId: ctx.requestId,
      metadata: { ...a.metadataActor, contact_id: contactId, destino: input.destino },
    });

    return {
      pending_post_id: criado.id,
      destino: input.destino,
      caption,
      hashtags,
      instrucao: ehStories
        ? "Mostre ao lead que vai publicar essa mídia como story (sem legenda) e só chame crm_instagram_confirmar_post depois que ele confirmar explicitamente."
        : "Mostre a legenda e as hashtags ao lead e só chame crm_instagram_confirmar_post depois que ele confirmar explicitamente.",
    };
  },
};

// ---------------------------------------------------------------------------
// crm_instagram_confirmar_post
// ---------------------------------------------------------------------------

const confirmarInputShape = {
  pending_post_id: z.string().uuid(),
};

export const crmInstagramConfirmarPost: McpToolDefinition<typeof confirmarInputShape> = {
  name: "crm_instagram_confirmar_post",
  description:
    "Publica de verdade no Instagram do lead o post que crm_instagram_preparar_post deixou pronto. " +
    "SÓ chame isto depois que o lead confirmou explicitamente, numa mensagem dele, que quer publicar — " +
    "nunca no mesmo turno em que o post foi preparado. Ação pública e irreversível.",
  inputSchema: confirmarInputShape,
  category: "write",
  // Mesma razão de `crm_instagram_preparar_post`: sem rota HTTP equivalente
  // de atendente, o piso é `ai_operator` — e aqui pesa mais ainda, porque
  // esta é a tool que publica de verdade.
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { data: pendente } = await ctx.supabase
      .from("instagram_pending_posts")
      .select("id, contact_id, destino, caption, hashtags, source_message_id, status")
      .eq("id", input.pending_post_id)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();
    if (!pendente) throw new Error("post_nao_encontrado");
    if (pendente.status !== "pending") throw new Error(`post_ja_${pendente.status}`);
    await garantirContatoAutorizado(ctx, pendente.contact_id);

    const conexao = await conexaoAtivaDoLead(ctx.supabase, ctx.organizationId, pendente.contact_id);
    if (!conexao) throw new Error("instagram_nao_conectado");

    const midia = await urlPublicaTemporaria(
      ctx.supabase,
      ctx.organizationId,
      pendente.source_message_id,
    );
    if (!midia) throw new Error("midia_indisponivel");
    if (midia.tipo === "outro") throw new Error("tipo_de_midia_nao_suportado");

    const legendaCompleta = [
      pendente.caption as string,
      ((pendente.hashtags as string[]) ?? []).map((h) => `#${h}`).join(" "),
    ]
      .filter(Boolean)
      .join("\n\n");

    const falhar = async (motivo: string): Promise<never> => {
      await ctx.supabase
        .from("instagram_pending_posts")
        .update({ status: "failed", error_message: motivo })
        .eq("id", pendente.id)
        .eq("organization_id", ctx.organizationId);
      const a = actorAudit(ctx);
      await audit({
        action: "instagram.post_falhou",
        actorUserId: a.actorUserId,
        actorApiTokenId: ctx.apiTokenId,
        organizationId: ctx.organizationId,
        resourceType: "instagram_pending_post",
        resourceId: pendente.id,
        requestId: ctx.requestId,
        metadata: { ...a.metadataActor, motivo },
      });
      throw new Error(motivo);
    };

    const container = await criarContainer({
      igUserId: conexao.igUserId,
      accessToken: conexao.accessToken,
      destino: pendente.destino as "feed" | "reels" | "stories",
      mediaUrl: midia.url,
      mediaTipo: midia.tipo,
      caption: legendaCompleta,
    });
    if (!container.ok) return falhar(container.motivo);

    const pronto = await esperarContainerPronto({
      containerId: container.containerId,
      accessToken: conexao.accessToken,
    });
    if (!pronto.ok) return falhar(pronto.motivo);

    const publicado = await publicarContainer({
      igUserId: conexao.igUserId,
      containerId: container.containerId,
      accessToken: conexao.accessToken,
    });
    if (!publicado.ok) return falhar(publicado.motivo);

    const permalink = await permalinkDoMedia({
      mediaId: publicado.mediaId,
      accessToken: conexao.accessToken,
    });

    await ctx.supabase
      .from("instagram_pending_posts")
      .update({
        status: "published",
        ig_media_id: publicado.mediaId,
        ig_permalink: permalink,
        published_at: new Date().toISOString(),
      })
      .eq("id", pendente.id)
      .eq("organization_id", ctx.organizationId);

    const a = actorAudit(ctx);
    await audit({
      action: "instagram.post_publicado",
      actorUserId: a.actorUserId,
      actorApiTokenId: ctx.apiTokenId,
      organizationId: ctx.organizationId,
      resourceType: "instagram_pending_post",
      resourceId: pendente.id,
      requestId: ctx.requestId,
      metadata: { ...a.metadataActor, ig_media_id: publicado.mediaId },
    });

    return {
      publicado: true,
      permalink,
      ig_media_id: publicado.mediaId,
    };
  },
};
