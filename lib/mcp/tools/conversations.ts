/**
 * MCP read tools sobre /api/v1/conversations e /api/v1/messages (Spec 11 §3.1).
 *
 * - `crm_list_conversations` -> listConversationsHandler
 * - `crm_get_conversation`   -> getConversationHandler
 * - `crm_get_conversation_history` -> listMessagesHandler (carrega historico)
 */
import { z } from "zod";

import {
  listConversationsHandler,
  getConversationHandler,
} from "@/app/api/v1/conversations/_handler";
import { listMessagesHandler } from "@/app/api/v1/messages/_handler";
import type { McpToolDefinition } from "../types";

const listInputShape = {
  contact_id: z.string().uuid().optional(),
  status: z.enum(["open", "claimed", "ai_handling", "closed", "archived"]).optional(),
  limit: z.number().int().min(1).max(50).default(10),
  cursor: z.string().optional(),
};

export const crmListConversations: McpToolDefinition<typeof listInputShape> = {
  name: "crm_list_conversations",
  description:
    "Lista conversas do CRM com filtros opcionais por contato e status. Retorna preview da ultima mensagem.",
  inputSchema: listInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const result = await listConversationsHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      {
        status: input.status,
        limit: input.limit,
        cursor: input.cursor,
      },
    );
    let conversations = result.conversations;
    if (input.contact_id) {
      conversations = conversations.filter((c) => c.contact_id === input.contact_id);
    }
    return {
      conversations: conversations.map((c) => ({
        id: c.id,
        contact_id: c.contact_id,
        channel: c.channel,
        status: c.status,
        assigned_to_user_id: c.assigned_to_user_id,
        last_message_preview: c.last_message_preview,
        last_message_at: c.last_message_at,
        unread_count: c.unread_count_for_assignee,
        is_group: c.is_group,
      })),
      cursor: result.cursor,
      has_more: result.has_more,
    };
  },
};

const getInputShape = {
  conversation_id: z.string().uuid(),
};

export const crmGetConversation: McpToolDefinition<typeof getInputShape> = {
  name: "crm_get_conversation",
  description:
    "Retorna detalhes de uma conversa pelo UUID. Inclui status, atribuicao, contato, ultima atividade.",
  inputSchema: getInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const conv = await getConversationHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      input.conversation_id,
    );
    return {
      id: conv.id,
      contact_id: conv.contact_id,
      channel_session_id: conv.channel_session_id,
      channel: conv.channel,
      status: conv.status,
      assigned_to_user_id: conv.assigned_to_user_id,
      assigned_at: conv.assigned_at,
      last_inbound_at: conv.last_inbound_at,
      last_outbound_at: conv.last_outbound_at,
      last_message_at: conv.last_message_at,
      last_message_preview: conv.last_message_preview,
      is_group: conv.is_group,
      group_chat_id: conv.group_chat_id,
      created_at: conv.created_at,
    };
  },
};

const historyInputShape = {
  conversation_id: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
};

export const crmGetConversationHistory: McpToolDefinition<typeof historyInputShape> = {
  name: "crm_get_conversation_history",
  description:
    "Carrega historico de mensagens de uma conversa. Use para dar contexto ao agente sem inflar o system prompt.",
  inputSchema: historyInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const result = await listMessagesHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      input.conversation_id,
      { limit: input.limit, cursor: input.cursor },
    );
    return {
      messages: result.messages.map((m) => ({
        id: m.id,
        direction: m.direction,
        type: m.type,
        body: m.body,
        media_url: m.media_url,
        sent_via: m.sent_via,
        sent_at: m.sent_at,
        status: m.status,
      })),
      cursor: result.cursor,
      has_more: result.has_more,
    };
  },
};
