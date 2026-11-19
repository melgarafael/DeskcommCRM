/**
 * AS TAREFAS POR MCP (#4516).
 *
 * ⚠️ CADA TOOL AQUI CHAMA O MESMO `_handler` DA ROTA
 * (`app/api/v1/tasks/_handler.ts`). Não há segunda regra de negócio: a
 * conferência de responsável/demanda, o `organization_id` explícito, o audit e
 * a idempotência são os de lá. Foi por isso que a regra saiu da rota.
 *
 * ⚠️ O ESCOPO PRÓPRIO (`tasks:read`/`tasks:write`) NÃO cabe em `requiresScope`:
 * essa união só conhece `mcp:read`/`mcp:write` (`lib/mcp/types.ts`), e o runtime
 * do agente nativo monta `ctx` SEM `tokenScopes`. A checagem é
 * `exigeEscopoDoTokenDeIntegracao`, que vale só para token de fora — o agente da
 * casa continua operando como sempre, e o token sem `tasks:write` fecha em 403
 * mesmo tendo `mcp:write`. Ver `lib/mcp/escopo-do-token.ts`.
 *
 * ⚠️ `created_by` é FK para `auth.users`: o handler grava `null` para ator que
 * não é pessoa. Sem isso o INSERT morre em 23503 e a integração não cria nada.
 */
import { z } from "zod";

import {
  criarTarefaHandler,
  editarTarefaHandler,
  excluirTarefaHandler,
  listarTarefasHandler,
  LIMITE_MAXIMO_DA_LISTA,
} from "@/app/api/v1/tasks/_handler";
import {
  ESCOPO_TAREFAS_ESCRITA,
  ESCOPO_TAREFAS_LEITURA,
} from "@/lib/api/escopos-do-token";
import { ApiError } from "@/lib/api/types";
import { exigeEscopoDoTokenDeIntegracao } from "@/lib/mcp/escopo-do-token";
import type { McpContext, McpToolDefinition } from "@/lib/mcp/types";
import { PRIORIDADES_DA_TAREFA, SITUACOES_DA_TAREFA } from "@/lib/tarefas/tipos";

/** O ensinamento por código de recusa — o mesmo tom das tools de agenda. */
const ENSINO_POR_CODIGO: Record<string, string> = {
  not_found: "não achei essa tarefa nesta organização. Confira o id com `crm_list_tasks`.",
  validation_failed:
    "os dados não fecharam (responsável fora da equipe, demanda encerrada ou vínculo inexistente). Confira antes de repetir.",
  state_conflict: "a demanda vinculada já foi encerrada. Crie a tarefa numa demanda em andamento.",
  idempotency_conflict:
    "essa chave de idempotência já foi usada com outro conteúdo. Use uma chave nova para uma tarefa nova.",
  idempotency_in_progress:
    "a mesma requisição ainda está em curso. Espere alguns instantes e repita com a MESMA chave.",
};

/**
 * Recusa de negócio vira RESPOSTA, não exceção: o cliente precisa do `motivo`
 * para decidir (repetir? pedir correção?), e uma string de erro crua perde o
 * código. Infra quebra continua subindo — não é limite de negócio.
 */
async function comRecusa<T>(
  chave: string,
  fn: () => Promise<T>,
): Promise<T | { [k: string]: unknown; motivo: string; mensagem: string }> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return {
      [chave]: false,
      motivo: e.code,
      mensagem: ENSINO_POR_CODIGO[e.code] ?? "não consegui completar agora.",
    };
  }
}

/** O contexto que o handler compartilha com a rota — mesma forma, mesmas regras. */
function ctxDoHandler(ctx: McpContext): Parameters<typeof listarTarefasHandler>[1] {
  return {
    organization_id: ctx.organizationId,
    actor: ctx.actor,
    requestId: ctx.requestId,
    ...(ctx.apiTokenId ? { apiTokenId: ctx.apiTokenId } : {}),
  };
}

const camposDaTarefa = {
  title: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(5000).nullable().optional(),
  due_date: z.string().datetime({ offset: true }).nullable().optional(),
  priority: z.enum(PRIORIDADES_DA_TAREFA).optional(),
  status: z.enum(SITUACOES_DA_TAREFA).optional(),
  lead_id: z.string().uuid().nullable().optional(),
  contact_id: z.string().uuid().nullable().optional(),
  demanda_id: z.string().uuid().nullable().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
};

const listaShape = {
  status: z.enum(SITUACOES_DA_TAREFA).optional(),
  priority: z.enum(PRIORIDADES_DA_TAREFA).optional(),
  lead_id: z.string().uuid().optional().describe("as tarefas deste negócio"),
  demanda_id: z.string().uuid().optional().describe("as tarefas desta demanda"),
  aberto: z
    .boolean()
    .optional()
    .describe("só o que ainda pede ação (pendente ou em andamento) — é o que a tela mostra por padrão"),
  assigned_to: z.string().uuid().optional().describe("as tarefas desta pessoa"),
  sem_responsavel: z.boolean().optional().describe("só as tarefas sem ninguém designado"),
  due_from: z.string().datetime({ offset: true }).optional(),
  due_to: z.string().datetime({ offset: true }).optional(),
  limite: z.number().int().min(1).max(LIMITE_MAXIMO_DA_LISTA).optional(),
};

export const crmListTasks: McpToolDefinition<typeof listaShape> = {
  name: "crm_list_tasks",
  description:
    "Lista as tarefas da organização em ordem de prazo, com o negócio de cada uma. " +
    "Use `aberto: true` para o que ainda pede ação e `assigned_to` para as de uma pessoa. " +
    "A lista corta em 500 linhas: se voltar cheia, estreite por responsável ou por data.",
  inputSchema: listaShape,
  category: "read",
  requiresRole: "ai_operator",
  requiresScope: "mcp:read",
  handler: async (input, ctx) =>
    comRecusa("listed", async () => {
      exigeEscopoDoTokenDeIntegracao(ctx, ESCOPO_TAREFAS_LEITURA);
      const r = await listarTarefasHandler(ctx.supabase, ctxDoHandler(ctx), {
        ...input,
        ...(input.sem_responsavel === true ? { sem_responsavel: true } : {}),
      });
      return { listed: true, total: r.tasks.length, tarefas: r.tasks };
    }),
};

const criacaoShape = {
  title: z.string().trim().min(1).max(255),
  description: z.string().max(5000).optional(),
  due_date: z.string().datetime({ offset: true }).optional().describe("quando vence, com fuso"),
  priority: z.enum(PRIORIDADES_DA_TAREFA).optional(),
  status: z.enum(SITUACOES_DA_TAREFA).optional(),
  lead_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
  demanda_id: z.string().uuid().optional(),
  assigned_to: z.string().uuid().optional().describe("id de um membro da equipe; sem isto a tarefa fica sem dono"),
  /**
   * A CHAVE DA CRIAÇÃO (#4516). Repetir a chamada com a MESMA chave devolve a
   * mesma tarefa em vez de criar outra — é o que salva a integração que retenta
   * por timeout. Sem chave, cada chamada cria uma tarefa nova.
   */
  idempotency_key: z
    .string()
    .uuid()
    .optional()
    .describe("repita com a MESMA chave se a chamada falhar por rede; repetir com a mesma chave NÃO duplica a tarefa"),
};

export const crmCreateTask: McpToolDefinition<typeof criacaoShape> = {
  name: "crm_create_task",
  description:
    "Cria uma tarefa para a equipe, opcionalmente presa a um negócio, contato ou demanda. " +
    "Sem `assigned_to` a tarefa fica sem dono. " +
    "Se você já tentou criar e não sabe se passou, repita com o mesmo `idempotency_key`: a segunda chamada devolve a mesma tarefa em vez de duplicar.",
  inputSchema: criacaoShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) =>
    comRecusa("created", async () => {
      exigeEscopoDoTokenDeIntegracao(ctx, ESCOPO_TAREFAS_ESCRITA);
      const { idempotency_key, ...campos } = input;
      const r = await criarTarefaHandler(
        ctx.supabase,
        { ...ctxDoHandler(ctx), ...(idempotency_key ? { idempotencyKey: idempotency_key } : {}) },
        { priority: "medium", status: "pending", ...campos },
      );
      return { created: true, tarefa: r.task };
    }),
};

const edicaoShape = {
  task_id: z.string().uuid(),
  ...camposDaTarefa,
};

export const crmUpdateTask: McpToolDefinition<typeof edicaoShape> = {
  name: "crm_update_task",
  description:
    "Edita uma tarefa: título, prazo, prioridade, situação, responsável e vínculos. " +
    "Para marcar como concluída prefira `crm_complete_task`. " +
    "Tarefa de outra organização não é encontrada — o id sozinho não atravessa organização.",
  inputSchema: edicaoShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) =>
    comRecusa("updated", async () => {
      exigeEscopoDoTokenDeIntegracao(ctx, ESCOPO_TAREFAS_ESCRITA);
      const { task_id, ...campos } = input;
      const r = await editarTarefaHandler(ctx.supabase, ctxDoHandler(ctx), {
        id: task_id,
        ...campos,
      });
      return { updated: true, tarefa: r.task };
    }),
};

const conclusaoShape = {
  task_id: z.string().uuid(),
  desfecho: z
    .enum(["concluida", "reaberta"])
    .optional()
    .describe("`concluida` (padrão) fecha a tarefa; `reaberta` devolve para pendente"),
};

export const crmCompleteTask: McpToolDefinition<typeof conclusaoShape> = {
  name: "crm_complete_task",
  description:
    "Fecha uma tarefa como concluída — ou reabre, com `desfecho: \"reaberta\"`. " +
    "A linha do tempo do negócio registra o fechamento UMA vez; repetir não duplica o registro. " +
    "Concluir não apaga: a tarefa continua na lista com a situação `done`.",
  inputSchema: conclusaoShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) =>
    comRecusa("completed", async () => {
      exigeEscopoDoTokenDeIntegracao(ctx, ESCOPO_TAREFAS_ESCRITA);
      const r = await editarTarefaHandler(ctx.supabase, ctxDoHandler(ctx), {
        id: input.task_id,
        status: input.desfecho === "reaberta" ? "pending" : "done",
      });
      return { completed: r.task.status === "done", tarefa: r.task };
    }),
};

const exclusaoShape = {
  task_id: z.string().uuid(),
};

export const crmDeleteTask: McpToolDefinition<typeof exclusaoShape> = {
  name: "crm_delete_task",
  description:
    "APAGA uma tarefa de vez. Não há como desfazer. " +
    "Se a intenção é só encerrar o trabalho, use `crm_complete_task` — apagar tira o registro de que a tarefa existiu. " +
    "Tarefa de outra organização não é encontrada.",
  inputSchema: exclusaoShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) =>
    comRecusa("deleted", async () => {
      exigeEscopoDoTokenDeIntegracao(ctx, ESCOPO_TAREFAS_ESCRITA);
      const r = await excluirTarefaHandler(ctx.supabase, ctxDoHandler(ctx), { id: input.task_id });
      return { deleted: r.deleted };
    }),
};
