/**
 * CONCLUSÃO E EXCLUSÃO DE TAREFA POR MCP (#4516) — as DUAS ferramentas que a
 * main não tem.
 *
 * ─── Por que este arquivo existe, e por que ele é separado ──────────────────
 *
 * A main criou o `lib/mcp/tools/tarefas.ts` dela (#4838), com SQL direto e TRÊS
 * ferramentas: `crm_list_tasks`, `crm_create_task` e `crm_update_task`. O #4516
 * pediu CINCO: as três mais `crm_complete_task` e `crm_delete_task`. Juntar os
 * dois lados no mesmo módulo não dá — o nome de wire é contrato e duas
 * definições do mesmo `name` no `allTools` são a mesma tool registrada duas
 * vezes.
 *
 * A decisão foi a de menor duplicação: o módulo `./tarefas` fica EXATAMENTE como
 * o da main (nada de reimplementá-lo aqui), e SÓ as duas ferramentas que ele não
 * tem moram neste arquivo. Elas chamam o MESMO `_handler` das rotas — não há
 * segunda regra de negócio: a leitura do estado anterior, o audit, a idempotência
 * e a linha do tempo do negócio são as de `app/api/v1/tasks/_handler.ts`.
 *
 * ⚠️ A UNIFICAÇÃO FICA EM ABERTO. O certo, a médio prazo, é uma família de
 * tarefas só — ou a da main passa a chamar o `_handler`, ou estas duas migram
 * para o SQL dela. Enquanto o dono do produto não decidir, o diff deste PR não
 * toca no arquivo da main, e esta é a menor costura que mantém as duas
 * capacidades publicadas.
 *
 * ⚠️ O ESCOPO PRÓPRIO (`tasks:write`) NÃO cabe em `requiresScope`: essa união só
 * conhece `mcp:read`/`mcp:write` (`lib/mcp/types.ts`), e o runtime do agente
 * nativo monta `ctx` SEM `tokenScopes`. A checagem é
 * `exigeEscopoDoTokenDeIntegracao`, que vale só para token de fora — o agente da
 * casa continua operando como sempre, e o token sem `tasks:write` fecha em 403
 * mesmo tendo `mcp:write`. Ver `lib/mcp/escopo-do-token.ts`.
 */
import { z } from "zod";

import { editarTarefaHandler, excluirTarefaHandler } from "@/app/api/v1/tasks/_handler";
import { ESCOPO_TAREFAS_ESCRITA } from "@/lib/api/escopos-do-token";
import { ApiError } from "@/lib/api/types";
import { exigeEscopoDoTokenDeIntegracao } from "@/lib/mcp/escopo-do-token";
import type { McpContext, McpToolDefinition } from "@/lib/mcp/types";

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
function ctxDoHandler(ctx: McpContext): Parameters<typeof editarTarefaHandler>[1] {
  return {
    organization_id: ctx.organizationId,
    actor: ctx.actor,
    requestId: ctx.requestId,
    ...(ctx.apiTokenId ? { apiTokenId: ctx.apiTokenId } : {}),
  };
}

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
