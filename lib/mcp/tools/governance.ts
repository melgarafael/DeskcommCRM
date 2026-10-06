/**
 * MCP tools de governança de atendimento (G6-01, spec 13 §6).
 *
 * Superfície para agentes externos (Vendaval):
 *   - crm_assign_conversation — atribui/transfere/libera (reuso de fn_conversation_assign)
 *   - crm_manage_tags         — add/remove tags em conversation|contact|lead (validação G3-05)
 *   - crm_get_queue_status    — snapshot da fila da org (read-only)
 *
 * org SEMPRE do ctx (fonte confiável), NUNCA do input. Escrita → audit dedicado
 * (além do mcp.tool_called que o server core já emite). Cross-org negado: fn
 * guard INB-06a (assign) e filtro organization_id explícito (tags).
 */
import { z } from "zod";

import { observeServiceOrigin } from "@/lib/atendimento/origem";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { normalizarTags } from "@/lib/contacts/tag-normalizada";
import { conversationTagSchema, conversationTagsSchema } from "@/lib/schemas/messaging";
import { getQueueStatus } from "@/lib/routing/queue";
import type { McpContext } from "../types";
import type { McpToolDefinition } from "../types";

/** Payload de auditoria a partir do ator do ctx (user humano ou ai_agent). */
function actorAudit(ctx: McpContext): {
  actorUserId: string | null;
  metadataActor: Record<string, unknown>;
} {
  const actor = ctx.actor;
  if (actor.type === "user") {
    return { actorUserId: actor.id, metadataActor: { actor_type: "user" } };
  }
  return {
    actorUserId: null,
    metadataActor: { actor_type: actor.type, actor_id: actor.id },
  };
}

// ---------------------------------------------------------------------------
// crm_assign_conversation
// ---------------------------------------------------------------------------

const assignInputShape = {
  conversation_id: z.string().uuid(),
  /** null = release (volta à fila). */
  to_user_id: z.string().uuid().nullable().default(null),
  reason: z.enum(["transfer", "release"]).default("transfer"),
};

/** Cross-field: release ⇔ to_user_id null; transfer ⇔ to_user_id preenchido. */
const assignObject = z
  .object(assignInputShape)
  .refine((d) => (d.to_user_id === null) === (d.reason === "release"), {
    message: "release exige to_user_id null; transfer exige to_user_id.",
  });

export const crmAssignConversation: McpToolDefinition<typeof assignInputShape> = {
  name: "crm_assign_conversation",
  description:
    "Atribui/transfere uma conversa a um atendente (reason='transfer', to_user_id preenchido) " +
    "ou libera de volta à fila (reason='release', to_user_id null). Grava assignment event " +
    "auditado. Recusa destino de outra org (guard de membership). Idempotente: se a conversa " +
    "já está no estado alvo, retorna sucesso sem duplicar evento.",
  inputSchema: assignInputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const parsed = assignObject.parse(input);

    // Defesa em profundidade — service role bypassa RLS: a conversa TEM que ser da org.
    const { data: conv, error: convErr } = await ctx.supabase
      .from("conversations")
      .select("id, organization_id, assigned_to_user_id")
      .eq("id", parsed.conversation_id)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();
    if (convErr) throw new Error(convErr.message);
    if (!conv) throw new Error("conversation_not_found");

    const currentOwner = conv.assigned_to_user_id ?? null;

    // Idempotência por (conversation_id, to, reason) — REPLAY (comando repetido
    // após o 1º já ter aplicado): a conversa JÁ está no dono alvo ⇒ nada a mudar,
    // retorna sucesso sem novo assignment event.
    if (currentOwner === parsed.to_user_id) {
      return {
        assigned: true,
        conversation_id: parsed.conversation_id,
        assigned_to_user_id: parsed.to_user_id,
        reason: parsed.reason,
        idempotent: true,
      };
    }

    // fn_conversation_assign: UPDATE + assignment event na MESMA transação; RAISE
    // (guard INB-06a) se destino não é membro ativo da org. p_enforce_expected=
    // true com o dono que ACABAMOS de ler ⇒ optimistic lock: sob CORRIDA (dois
    // assigns idênticos leem o mesmo dono antigo), o 1º vence (1 evento) e o 2º
    // vê o dono já mudado (v_from ≠ expected) ⇒ 0 rows, SEM evento duplicado.
    const { data: rows, error: assignErr } = await ctx.supabase.rpc("fn_conversation_assign", {
      p_organization_id: ctx.organizationId,
      p_conversation_id: parsed.conversation_id,
      p_to_user_id: parsed.to_user_id,
      p_reason: parsed.reason,
      p_expected_assignee: currentOwner,
      p_enforce_expected: true,
    });
    if (assignErr) throw new Error(assignErr.message);
    if (!Array.isArray(rows) || rows.length === 0) {
      // 0 rows = perdeu o optimistic lock. Re-lê: se o dono já é o alvo, foi a
      // corrida idêntica (sibling aplicou) ⇒ idempotente. Senão, outro assign
      // concorrente venceu com destino diferente ⇒ conflito.
      const { data: recheck } = await ctx.supabase
        .from("conversations")
        .select("assigned_to_user_id")
        .eq("id", parsed.conversation_id)
        .eq("organization_id", ctx.organizationId)
        .maybeSingle();
      if (recheck && (recheck.assigned_to_user_id ?? null) === parsed.to_user_id) {
        return {
          assigned: true,
          conversation_id: parsed.conversation_id,
          assigned_to_user_id: parsed.to_user_id,
          reason: parsed.reason,
          idempotent: true,
        };
      }
      throw new Error("assignment_conflict");
    }

    const a = actorAudit(ctx);
    await audit({
      action: parsed.reason === "release" ? "conversation.released" : "conversation.transferred",
      actorUserId: a.actorUserId,
      actorApiTokenId: ctx.apiTokenId,
      organizationId: ctx.organizationId,
      resourceType: "conversation",
      resourceId: parsed.conversation_id,
      requestId: ctx.requestId,
      metadata: { ...a.metadataActor, to_user_id: parsed.to_user_id, reason: parsed.reason, via: "mcp" },
    });

    return {
      assigned: true,
      conversation_id: parsed.conversation_id,
      assigned_to_user_id: parsed.to_user_id,
      reason: parsed.reason,
      idempotent: false,
    };
  },
};

// ---------------------------------------------------------------------------
// crm_manage_tags
// ---------------------------------------------------------------------------

const TAG_TARGET_TABLE = {
  conversation: "conversations",
  contact: "contacts",
  lead: "crm_leads",
} as const;

const TAG_AUDIT_ACTION = {
  conversation: "conversation.tags_changed",
  contact: "contact.tags_changed",
  lead: "lead.tags_changed",
} as const;

/**
 * O evento "ganhou tag" de cada alvo — o MESMO que a tela emite (PATCH de
 * contato em `app/api/v1/contacts/_handler.ts`, PATCH de negócio em
 * `app/api/v1/leads/_handler.ts`). Sem ele, a regra "Quando um contato ganhar
 * uma tag" disparava quando a pessoa punha a tag na tela e ficava muda quando
 * um sistema de fora (n8n) punha a mesma tag pela MCP — a mesma ação, dois
 * desfechos. Conversa não tem esse gatilho: fica de fora.
 */
const TAG_ADDED_EVENT = {
  contact: { eventType: "contact.tag_added", entityKind: "contact" },
  lead: { eventType: "lead.tag_added", entityKind: "crm_lead" },
} as const;

const tagsInputShape = {
  target_kind: z.enum(["conversation", "contact", "lead"]),
  target_id: z.string().uuid(),
  add: z.array(z.string()).optional(),
  remove: z.array(z.string()).optional(),
};

export const crmManageTags: McpToolDefinition<typeof tagsInputShape> = {
  name: "crm_manage_tags",
  description:
    "Adiciona/remove tags em uma conversation, contact ou lead. Tags são normalizadas " +
    "(lowercase, trim, ≤40 chars cada, ≤20 no total). Informe ao menos um de add/remove. " +
    "Recusa alvo de outra org.",
  inputSchema: tagsInputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const addTags = (input.add ?? []).map((t) => conversationTagSchema.parse(t));
    const removeTags = new Set((input.remove ?? []).map((t) => conversationTagSchema.parse(t)));
    if (addTags.length === 0 && removeTags.size === 0) {
      throw new Error("informe ao menos uma tag em add ou remove");
    }

    const table = TAG_TARGET_TABLE[input.target_kind];

    // O contato do negócio entra na origem do atendimento do evento "ganhou tag".
    const colunas: string = input.target_kind === "lead" ? "id, tags, contact_id" : "id, tags";
    const { data, error: fetchErr } = await ctx.supabase
      .from(table)
      .select(colunas)
      .eq("id", input.target_id)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();
    if (fetchErr) throw new Error(fetchErr.message);
    if (!data) throw new Error("target_not_found");
    const row = data as unknown as { tags: string[] | null; contact_id?: string | null };

    // O que já está gravado pode vir em caixa mista (dado anterior à #1224):
    // sem normalizar aqui, `remove: ["vip"]` não alcançaria o "VIP" do banco e
    // o marcador ficaria impossível de tirar pela MCP.
    const current = normalizarTags(row.tags ?? []);
    const merged = [...current, ...addTags].filter((t) => !removeTags.has(t));
    // Dedup + teto de 20 (rejeita se estourar) — mesma validação da G3-05.
    const nextTags = conversationTagsSchema.parse(merged);

    // Só as tags que o alvo NÃO tinha: pôr de novo a que já estava não é "ganhar".
    const addedTags = nextTags.filter((t) => !current.includes(t));
    const eventoDeTag = input.target_kind === "conversation" ? null : TAG_ADDED_EVENT[input.target_kind];
    const contatoDoAlvo =
      input.target_kind === "contact"
        ? input.target_id
        : (row.contact_id ?? null);
    // Observada ANTES da escrita, como a tela faz: é o atendimento em que a tag entrou.
    const tagServiceOrigin =
      eventoDeTag && addedTags.length > 0
        ? await observeServiceOrigin(ctx.supabase, ctx.organizationId, contatoDoAlvo)
        : null;

    const { error: updateErr } = await ctx.supabase
      .from(table)
      .update({ tags: nextTags })
      .eq("id", input.target_id)
      .eq("organization_id", ctx.organizationId);
    if (updateErr) throw new Error(updateErr.message);

    const a = actorAudit(ctx);
    await audit({
      action: TAG_AUDIT_ACTION[input.target_kind],
      actorUserId: a.actorUserId,
      actorApiTokenId: ctx.apiTokenId,
      organizationId: ctx.organizationId,
      resourceType: input.target_kind,
      resourceId: input.target_id,
      requestId: ctx.requestId,
      metadata: { ...a.metadataActor, tags: nextTags, via: "mcp" },
    });

    if (eventoDeTag && addedTags.length > 0) {
      // Mesmo envelope da tela. A tag já está gravada: falha ao emitir vira log,
      // nunca desfaz a escrita nem derruba a ferramenta.
      const { error: emitErr } = await ctx.supabase.rpc("emit_event", {
        p_event_type: eventoDeTag.eventType,
        p_entity_kind: eventoDeTag.entityKind,
        p_entity_id: input.target_id,
        p_payload: { added_tags: addedTags, tags: nextTags, service_origin: tagServiceOrigin },
        p_metadata: { request_id: ctx.requestId, ...a.metadataActor, via: "mcp" },
        p_organization_id: ctx.organizationId,
      });
      if (emitErr) {
        logger.error("[crm_manage_tags] emit_event falhou", {
          organization_id: ctx.organizationId,
          event_type: eventoDeTag.eventType,
          error: emitErr.message,
        });
      }
    }

    return { target_kind: input.target_kind, target_id: input.target_id, tags: nextTags };
  },
};

// ---------------------------------------------------------------------------
// crm_get_queue_status
// ---------------------------------------------------------------------------

const queueInputShape = {};

export const crmGetQueueStatus: McpToolDefinition<typeof queueInputShape> = {
  name: "crm_get_queue_status",
  description:
    "Snapshot da fila de atendimento da org: queue_size (conversas sem dono e abertas), " +
    "avg_wait_seconds (espera média desde a última mensagem do cliente) e " +
    "online_eligible_count (atendentes que podem puxar da fila agora). Read-only.",
  inputSchema: queueInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (_input, ctx) => {
    return getQueueStatus(ctx.supabase, ctx.organizationId, new Date());
  },
};
