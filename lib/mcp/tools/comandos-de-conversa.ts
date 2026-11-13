import { z } from "zod";

/**
 * OS COMANDOS DE CONVERSA COMO CAPACIDADE (#4517).
 *
 * ─── O buraco que isto fecha ──────────────────────────────────────────────
 *
 * Até aqui, para desligar o atendimento automático de uma conversa por
 * integração não havia rota nem ferramenta. O jeito que sobrava era
 * `crm_assign_conversation`/transferência — e transferir faz DUAS coisas que a
 * issue proíbe: troca o responsável da conversa (`assignee_kind='user'`) e o
 * responsável do NEGÓCIO (`crm_leads.assigned_to`). Pausar virava takeover, e o
 * dono do funil mudava sem ninguém pedir.
 *
 * ─── Por que quatro ferramentas e não uma ─────────────────────────────────
 *
 * Cada gesto tem um efeito e um risco próprios: pausar cala a IA (o cliente
 * deixa de ser respondido), retomar a religa, fechar encerra o atendimento,
 * reabrir o ressuscita. Uma ferramenta só, com um campo `acao`, esconderia o que
 * o modelo está pedindo e deixaria o catálogo (que é lido por GENTE na tela)
 * falando de um verbo que ninguém reconhece.
 *
 * ─── A regra dura: o AGENTE não se des-trava ──────────────────────────────
 *
 * As quatro recusam `actor.type === "ai_agent"`, e a recusa mora no handler, não
 * no papel (mesmo precedente de `crm_resume_ai_attendance`, #3947): um papel de
 * ranking maior viraria permissão por acidente. Quem pausa é gente ou integração
 * com `conversations:write`; o agente pausando a si mesmo é o gesto que a issue
 * veio impedir.
 */
import type { McpContext, McpToolDefinition } from "../types";
import {
  pausarIaHandler,
  retomarIaHandler,
  fecharConversaHandler,
  reabrirConversaHandler,
} from "@/app/api/v1/conversations/[id]/_handler";
import { ESCOPO_CONVERSAS_ESCRITA } from "@/lib/api/escopos-do-token";
import { exigeEscopoDoTokenDeIntegracao } from "../escopo-do-token";
import { ApiError } from "@/lib/api/types";

const comandoShape = {
  conversation_id: z.string().uuid().describe("UUID da conversa."),
  expected_revision: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("revisão do atendimento lida antes; evita agir sobre estado que mudou"),
};

/** O ctx do handler, montado a partir do ctx do MCP (sem input do chamador). */
function ctxDoHandler(
  ctx: Pick<McpContext, "organizationId" | "actor" | "requestId" | "apiTokenId">,
) {
  return {
    organization_id: ctx.organizationId,
    actor: ctx.actor,
    requestId: ctx.requestId,
    ...(ctx.apiTokenId ? { apiTokenId: ctx.apiTokenId } : {}),
  };
}

/**
 * A recusa em voz alta: o agente não comanda a própria automação.
 *
 * `ApiError` é `(status, code, details, requestId, message?)` — o texto É O
 * QUINTO argumento. Passá-lo em terceiro publicava `forbidden` no lugar da
 * frase (`super(message ?? code)`), que é o defeito que o commit anterior
 * consertou nas rotas e deixou aqui: a varredura parou no `_handler` e não
 * entrou nas tools MCP. Daí o `ctx.requestId` na assinatura: o 403 precisa
 * voltar correlacionável como os outros.
 */
function recusarAgente(ctx: { actor: { type: string }; requestId: string }): void {
  if (ctx.actor.type === "ai_agent") {
    throw new ApiError(
      403,
      "forbidden",
      undefined,
      ctx.requestId,
      "Quem pausa, retoma, encerra ou reabre uma conversa é uma pessoa ou uma integração autorizada — o próprio agente não comanda a sua automação.",
    );
  }
}

export const crmPauseAi: McpToolDefinition<typeof comandoShape> = {
  name: "crm_pause_ai",
  description:
    "Desliga o atendimento automático desta conversa: o cliente para de ser respondido pela IA " +
    "até alguém retomar. NÃO troca o responsável da conversa nem o do negócio — se a conversa " +
    "está sem responsável, continua sem. Use quando uma pessoa vai assumir o atendimento e pediu " +
    "para a IA não responder por cima.",
  inputSchema: comandoShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    recusarAgente(ctx);
    exigeEscopoDoTokenDeIntegracao(ctx, ESCOPO_CONVERSAS_ESCRITA);

    const r = await pausarIaHandler(ctx.supabase, ctxDoHandler(ctx), input.conversation_id);
    return {
      paused: true,
      assumiu_ao_pausar: r.assumiu_ao_pausar,
      conversation: r.conversation,
    };
  },
};

export const crmResumeAi: McpToolDefinition<typeof comandoShape> = {
  name: "crm_resume_ai",
  description:
    "Religa o atendimento automático nesta conversa. NÃO solta o responsável humano: se uma " +
    "pessoa é dona da conversa, a IA continua sem responder e o retorno diz isso em " +
    "automacao_liberada. Sem responsável humano e sem o contato marcado como sempre atendimento " +
    "humano, a IA volta a responder na próxima mensagem.",
  inputSchema: comandoShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    recusarAgente(ctx);
    exigeEscopoDoTokenDeIntegracao(ctx, ESCOPO_CONVERSAS_ESCRITA);

    const r = await retomarIaHandler(ctx.supabase, ctxDoHandler(ctx), input.conversation_id);
    return {
      reactivated: r.automacao_liberada,
      automacao_liberada: r.automacao_liberada,
      motivo_bloqueio: r.motivo_bloqueio,
      ...(r.continuidade ? { continuidade: r.continuidade } : {}),
    };
  },
};

export const crmCloseConversation: McpToolDefinition<typeof comandoShape> = {
  name: "crm_close_conversation",
  description:
    "Encerra o atendimento desta conversa — a MESMA transição do botão Encerrar da tela: " +
    "registra o fim no atendimento e libera a fila. Não reabre depois por acidente; para voltar " +
    "atrás use crm_reopen_conversation. Se a conversa mudou desde que você leu, informe " +
    "expected_revision e a chamada recusa em vez de encerrar por cima.",
  inputSchema: comandoShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    recusarAgente(ctx);
    exigeEscopoDoTokenDeIntegracao(ctx, ESCOPO_CONVERSAS_ESCRITA);

    const { conversation, devolucao } = await fecharConversaHandler(
      ctx.supabase,
      ctxDoHandler(ctx),
      input.conversation_id,
      input.expected_revision !== undefined ? { expectedRevision: input.expected_revision } : {},
    );
    return { ...conversation, ...(devolucao ? { devolucao } : {}) };
  },
};

export const crmReopenConversation: McpToolDefinition<typeof comandoShape> = {
  name: "crm_reopen_conversation",
  description:
    "Reabre uma conversa encerrada — a MESMA transição do botão Reabrir da tela. O atendimento " +
    "volta a contar a partir de agora e a conversa volta para a fila de quem estava com ela. Use " +
    "quando o cliente voltou a falar de um assunto que tinha sido encerrado.",
  inputSchema: comandoShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    recusarAgente(ctx);
    exigeEscopoDoTokenDeIntegracao(ctx, ESCOPO_CONVERSAS_ESCRITA);

    const { conversation } = await reabrirConversaHandler(
      ctx.supabase,
      ctxDoHandler(ctx),
      input.conversation_id,
      input.expected_revision !== undefined ? { expectedRevision: input.expected_revision } : {},
    );
    return { reopened: true, conversation };
  },
};
