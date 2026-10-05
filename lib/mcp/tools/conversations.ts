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
import { ApiError } from "@/lib/api/types";
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
    "Campos de governança por conversa: assignee_kind ('user'|'ai'|null), assigned_to_user_id + assigned_to_user_name (só o nome do atendente, sem email/telefone), tags[], e queue_position (posição 1-based na fila do inbox — só quando na fila, senão null). " +
    "Em conversa de atendimento, devolve apenas as conversas do contato desta conversa.",
  inputSchema: listInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    // ── QUEM ESTÁ NA OUTRA PONTA (#2178 → #2184) ──────────────────────────
    //
    // `ctx.contatoDoTurno` é contexto de CONFIANÇA (injetado por
    // `lib/ai/runtime/tools.ts`, nunca escrito pelo modelo); sem ele — rota
    // HTTP, MCP externo, agente sem conversa — `contatoEfetivo` é o
    // `contact_id` pedido, ou nada. Sem contato, a listagem é a de antes; com
    // `contact_id` pedido, o filtro agora vai na consulta e não na página.
    const doTurno = ctx.contatoDoTurno;
    // ESCOPO, e não tradução: com o contato do turno na mão, pedir
    // explicitamente o contato de OUTRO cliente é interseção vazia — devolver
    // as conversas do turno responderia outra pergunta, e devolver as do
    // cliente pedido deixaria o texto do lado de lá sair pelo turno. A lista
    // vazia é a resposta honesta aos dois lados, e é o que já acontecia.
    if (doTurno && input.contact_id && input.contact_id !== doTurno) {
      return { conversations: [], cursor: null, has_more: false };
    }
    const contatoEfetivo = doTurno ?? input.contact_id;
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
        // `tag` e `modo` também saem `undefined` EXPLICITO, e pela MESMA razão do
        // `comando`: o `.transform()` do schema de marcador (#1274) torna a chave
        // de SAÍDA obrigatória-de-tipo (`string[] | undefined`), não opcional.
        // A tool do MCP não expõe filtro por etiqueta (quem pergunta é a tela), e
        // omitir a chave seria erro de tipo — não omissão silenciosa.
        tag: undefined,
        modo: undefined,
        // O CONTATO VAI NA CONSULTA, não no recorte depois dela (#2184).
        // Filtrar a página já truncada escondia a conversa mais antiga do
        // mesmo cliente (fora da página) e deixava o cursor descrevendo a
        // varredura da organização; no `WHERE`, cursor e `has_more` passam a
        // ser honestos para o conjunto do contato.
        contact_id: contatoEfetivo,
        limit: input.limit,
        cursor: input.cursor,
      },
    );
    const conversations = result.conversations;
    // ── O ESCOPO AGORA MORA NO `WHERE`, E A PAGINAÇÃO SEGUE VIVA (#2184) ──
    //
    // Aqui havia um filtro em memória sobre a página devolvida pelo handler, e
    // com ele o `cursor`/`has_more` eram zerados ("a próxima página voltaria a
    // ser varredura"). O defeito medido na issue: com 10 conversas por página,
    // a conversa mais antiga do mesmo cliente fora daquela página ficava
    // invisível para o agente, e o `has_more: false` dizia que não havia mais
    // nada. Com o contato no predicado, a página É do cliente — a próxima
    // página também, então os dois voltam a valer.
    //
    // Mesmo escopo do #2175: a listagem filtra `organization_id`, então não há
    // vazamento entre ORGANIZAÇÕES, mas alcançava os outros clientes da MESMA
    // organização — com `last_message_preview` junto, que é texto do lado de
    // lá indo para o WhatsApp do cliente A, encaminhável, sem volta.
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
    "Governança: assignee_kind ('user'|'ai'|null), assigned_to_user_id + assigned_to_user_name (só o nome, sem email/telefone), tags[], e queue_position (1-based na fila do inbox — null quando não está na fila). " +
    "Em conversa de atendimento, devolve apenas conversas do contato desta conversa.",
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
    ).catch((e: unknown) => {
      // Com turno, o `404` (não existe, ou é de outra organização) vira a
      // MESMA recusa da conversa de outro cliente, como no histórico: um uuid
      // não ganha veredito sobre existência. Sem turno, sobe como antes; erro
      // que não é `404` sobe sempre.
      if (ctx.contatoDoTurno && e instanceof ApiError && e.status === 404) return null;
      throw e;
    });
    // ── A CONVERSA DE QUEM NÃO É DESTA CONVERSA NÃO ABRE AQUI (#2178) ────────
    //
    // RECUSA, e não tradução: trocar o uuid pedido pelo da conversa do turno
    // faria o modelo perguntar por uma conversa e receber outra — a mesma
    // razão que `crm_get_contact` recusa em vez de trocar (#2158).
    //
    // A ida ao handler ACONTECE porque é ela que diz de quem é a conversa
    // (`conversation_id` não carrega `contact_id`); o que não sai daqui é a
    // RESPOSTA — o registro de B é descartado e o modelo vê a recusa, no
    // mesmo formato que `negocioDaEscritaDoTurno` devolve, auditada como
    // recusa pelo runtime (`contato_da_conversa:fora_da_conversa`).
    //
    // `ctx.contatoDoTurno` é contexto de CONFIANÇA (injetado por
    // `lib/ai/runtime/tools.ts`, nunca escrito pelo modelo); sem ele — rota
    // HTTP, MCP externo, agente sem conversa — qualquer conversa da
    // organização segue abrindo como antes. O Operador recebe o contato do
    // turno e também fica escopado.
    if (!conv || (ctx.contatoDoTurno && conv.contact_id !== ctx.contatoDoTurno)) {
      return {
        permitido: false,
        motivo: "fora_da_conversa",
        mensagem:
          "esta conversa é com outra pessoa — abrir a conversa de um cliente que não é o desta " +
          "conversa não é sua para ler; siga a conversa com quem está falando.",
      };
    }
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
    "Carrega historico de mensagens de uma conversa. Use para dar contexto ao agente sem inflar o system prompt." +
    " Em conversa de atendimento, devolve apenas o histórico da conversa do contato desta conversa.",
  inputSchema: historyInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    // ── O HISTÓRICO DE QUEM NÃO É DESTA CONVERSA NÃO SAI DAQUI (#2178) ──────
    //
    // A mesma recusa de `crm_get_conversation`, e ANTES de ler as mensagens:
    // o histórico é a leitura que mais sai do prédio (texto de ponta a
    // ponta), e carregar a página de B só para jogá-la fora seria deixar o
    // dado do outro cliente entrar na memória do turno sem necessidade.
    //
    // A conferência é a do `getConversationHandler` — a MESMA que a tela usa
    // —, porque `listMessagesHandler` recebe o uuid da conversa e não devolve
    // `contact_id`. Aqui ela custa uma ida extra ao banco, e só quando há
    // contato do turno: sem ele, o caminho é idêntico ao de antes.
    //
    // ── O `404` NÃO PODE VIRAR ORÁCULO (#2184) ────────────────────────────
    //
    // O handler responde `404 not_found` para DUAS coisas que ele não
    // distingue, de propósito: o id não existe, e o id é de outra
    // organização — a consulta filtra `organization_id` e os dois viram a
    // mesma "linha ausente". Com o 404 subindo, o turno ficava respondendo
    // `404` para um uuid inexistente e `fora_da_conversa` para a conversa do
    // outro cliente: dois estados distintos para o MESMO "não é seu para
    // ler", e o primeiro deles ainda mudava conforme um campo de contexto
    // (sem contato do turno, o uuid inexistente segue devolvendo lista vazia).
    //
    // Por isso o `404` vira a MESMA recusa do cliente de outro contato. O
    // contrato do handler não muda (a rota HTTP continua respondendo `404`),
    // quem erra o uuid não ganha um veredito sobre existência, e as três
    // respostas — não existe, é de outra organização, é de outro cliente —
    // ficam byte a byte iguais. `ApiError` que não seja `404` sobe: infra não
    // é limite de negócio (mesma regra de `lib/mcp/tools/agendamento.ts`).
    if (ctx.contatoDoTurno) {
      let conv: { contact_id: string | null } | null = null;
      try {
        conv = await getConversationHandler(
          ctx.supabase,
          {
            organization_id: ctx.organizationId,
            actor: ctx.actor,
            requestId: ctx.requestId,
          },
          input.conversation_id,
        );
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 404) throw e;
        conv = null;
      }
      if (!conv || conv.contact_id !== ctx.contatoDoTurno) {
        return {
          permitido: false,
          motivo: "fora_da_conversa",
          mensagem:
            "esta conversa é com outra pessoa — o histórico de um cliente que não é o desta " +
            "conversa não é seu para ler; siga a conversa com quem está falando.",
        };
      }
    }
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
