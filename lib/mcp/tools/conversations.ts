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
import { audit } from "@/lib/audit";
import {
  criarRascunho,
  JANELA_MAXIMA_HORAS,
  TEXTO_MAXIMO,
} from "@/lib/inbox/rascunho-sugerido";
import { getQueuePositions } from "@/lib/routing/queue";
import { resolveUserNames } from "./_users";
import type { McpToolDefinition } from "../types";

/**
 * Conversa está na fila = sem dono ∧ status de espera.
 *
 * A lista de status vem da constante compartilhada, e não de um literal: era
 * `=== "open"` aqui, `in ('open','pending')` no trigger de roteamento, e as duas
 * coisas ao mesmo tempo dentro de `lib/routing/queue.ts`. O que a IA lia pela
 * tool e o que a pessoa via na tela não eram a mesma fila.
 */
function isInQueue(c: { comando_da_conversa?: string | null }): boolean {
  // Ele decide UMA coisa: vale a pena buscar as posições de fila para esta
  // página? Por isso é liberal de propósito — pergunta "não tem dono e não
  // acabou", que cobre tanto a org COM automático (só `aguardando` está na fila)
  // quanto a SEM (`automatico` também está, ver `comandosDaFila`). Errar para o
  // lado do sim custa uma consulta; errar para o não some com a posição que a IA
  // devolve ao cliente.
  const q = c.comando_da_conversa;
  return q === "aguardando" || q === "automatico";
}

const listInputShape = {
  contact_id: z.string().uuid().optional(),
  // `pending` entra: é o estado da conversa que o próprio agente escalou, e sem
  // ele a IA não conseguia listar o que ela mesma passou para uma pessoa.
  status: z
    .enum(["open", "pending", "claimed", "ai_handling", "closed", "archived"])
    .optional(),
  limit: z.number().int().min(1).max(50).default(10),
  cursor: z.string().optional(),
};

export const crmListConversations: McpToolDefinition<typeof listInputShape> = {
  name: "crm_list_conversations",
  description:
    "Lista conversas do CRM com filtros opcionais por contato e status. Retorna preview da ultima mensagem. " +
    "Campos de governança por conversa: assignee_kind ('user'|'ai'|null), assigned_to_user_id + assigned_to_user_name (só o nome do atendente, sem email/telefone), tags[], e queue_position (posição 1-based na fila do inbox — só quando na fila, senão null).",
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
        // O handler espera LISTA desde que o filtro passou a aceitar vários.
        status: input.status ? [input.status] : undefined,
        // `undefined` EXPLÍCITO: `.optional()` no Zod produz uma chave
        // OBRIGATÓRIA de tipo `X | undefined`, não uma chave opcional — omiti-la
        // é erro de tipo. A tool do MCP não expõe filtro por comando (quem
        // pergunta é a tela), então ela não filtra por ele.
        comando: undefined,
        limit: input.limit,
        cursor: input.cursor,
      },
    );
    let conversations = result.conversations;
    if (input.contact_id) {
      conversations = conversations.filter((c) => c.contact_id === input.contact_id);
    }
    // Nomes (dedupe) e posições de fila (1 query cada) — sem N+1 na listagem.
    const names = await resolveUserNames(
      ctx.supabase,
      conversations.map((c) => c.assigned_to_user_id),
    );
    const queueMap = conversations.some(isInQueue)
      ? await getQueuePositions(ctx.supabase, ctx.organizationId)
      : new Map<string, number>();
    return {
      conversations: conversations.map((c) => ({
        id: c.id,
        contact_id: c.contact_id,
        channel: c.channel,
        status: c.status,
        assigned_to_user_id: c.assigned_to_user_id,
        assignee_kind: c.assignee_kind,
        assigned_to_user_name: c.assigned_to_user_id
          ? (names.get(c.assigned_to_user_id) ?? null)
          : null,
        tags: c.tags ?? [],
        queue_position: queueMap.get(c.id) ?? null,
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
    "Retorna detalhes de uma conversa pelo UUID. Inclui status, atribuicao, contato, ultima atividade. " +
    "Governança: assignee_kind ('user'|'ai'|null), assigned_to_user_id + assigned_to_user_name (só o nome, sem email/telefone), tags[], e queue_position (1-based na fila do inbox — null quando não está na fila).",
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
    const names = await resolveUserNames(ctx.supabase, [conv.assigned_to_user_id]);
    const queue_position = isInQueue(conv)
      ? ((await getQueuePositions(ctx.supabase, ctx.organizationId)).get(conv.id) ?? null)
      : null;
    return {
      id: conv.id,
      contact_id: conv.contact_id,
      channel_session_id: conv.channel_session_id,
      channel: conv.channel,
      status: conv.status,
      assigned_to_user_id: conv.assigned_to_user_id,
      assignee_kind: conv.assignee_kind,
      assigned_to_user_name: conv.assigned_to_user_id
        ? (names.get(conv.assigned_to_user_id) ?? null)
        : null,
      tags: conv.tags ?? [],
      queue_position,
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

const rascunhoInputShape = {
  conversation_id: z
    .string()
    .uuid()
    .describe(
      "Conversa que recebe o texto sugerido. Se ainda não existir, POST /api/v1/conversations/open-with-contact abre.",
    ),
  texto: z
    .string()
    .min(1)
    .max(TEXTO_MAXIMO)
    .describe(
      "Texto sugerido para a pessoa revisar antes de enviar. 1 a " +
        String(TEXTO_MAXIMO) +
        " caracteres, o mesmo teto do envio.",
    ),
  origem: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .default("integracao")
    .describe("De onde veio o texto (ex.: 'erp'). É o que a caixa de entrada mostra no aviso de origem."),
  expira_em_horas: z
    .number()
    .int()
    .min(1)
    .max(JANELA_MAXIMA_HORAS)
    .optional()
    .describe("Janela de validade do rascunho, em horas. Padrão 24."),
};

/**
 * MCP write tool — crm_create_conversation_draft (issue #1611).
 *
 * A LACUNA: quem integra tem duas saídas e as duas são ruins — enviar por
 * token (a bolha diz `Sistema`, `sent_by_user_id` nulo, IA não silenciada como
 * no envio humano) ou copiar-e-colar. Esta tool guarda o TEXTO no servidor e
 * devolve a URL; **nada é enviado**, e o envio continua sendo clique de gente
 * (`sent_via='user'`).
 *
 * DOUTRINA DIRC: nenhuma regra nova aqui — `criarRascunho` é o MESMO módulo que
 * `POST /api/v1/conversations/[id]/drafts` chama (filtro de organização na
 * conferência da conversa, teto de 4096, janela de 24h). Os caminhos são dois;
 * a casa é uma.
 */
export const crmCreateConversationDraft: McpToolDefinition<typeof rascunhoInputShape> = {
  name: "crm_create_conversation_draft",
  description:
    "Cria um RASCUNHO de mensagem para uma conversa, guardado no servidor. NADA é enviado: a pessoa que atende abre a conversa com o texto já no campo e o aviso de origem, e só o clique dela envia. Use quando a mensagem precisa sair de uma PESSOA, mas o texto vem de outro sistema (cobrança vencida, documento faltando, formulário a reenviar). Devolve draft_id e a URL /app/inbox?id=<conversa>&rascunho=<draft_id>.",
  inputSchema: rascunhoInputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const rascunho = await criarRascunho(ctx.supabase, {
      organizationId: ctx.organizationId,
      conversationId: input.conversation_id,
      texto: input.texto,
      origem: input.origem,
      expiraEmHoras: input.expira_em_horas,
      apiTokenId: ctx.apiTokenId,
    });
    if (!rascunho.ok) {
      throw new Error(
        rascunho.motivo === "conversa_nao_encontrada"
          ? "Conversa não encontrada nesta organização."
          : rascunho.motivo === "origem_invalida"
            ? "Origem do rascunho inválida."
            : "Texto do rascunho inválido.",
      );
    }
    await audit({
      action: "conversation.draft_created",
      actorUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
      actorApiTokenId: ctx.apiTokenId,
      organizationId: ctx.organizationId,
      resourceType: "conversation",
      resourceId: input.conversation_id,
      requestId: ctx.requestId,
      metadata: { draft_id: rascunho.draftId, origem: input.origem, via: "mcp" },
    });
    return { draft_id: rascunho.draftId, url: rascunho.url };
  },
};
