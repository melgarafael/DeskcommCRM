/**
 * Ferramentas MCP para o domínio de Tarefas (`crm_tasks`).
 *
 * Implementa:
 *  - `crm_create_task` (write): Criação com validação de responsável e fechamento de laço no Sistema Vivo.
 *  - `crm_list_tasks` (read): Consulta filtrada e paginada respeitando isolamento multi-tenant.
 *  - `crm_update_task` (write): Atualização de status (ex: done), prazo, prioridade e responsáveis.
 */
import { z } from "zod";

import { audit } from "@/lib/audit";
import { portaDaAplicacao } from "@/lib/db";
import { registraAtividadeDaTarefa } from "@/lib/tarefas/atividade";
import { conferirDemanda } from "@/lib/tarefas/demanda";
import { criarProximaSemDerrubar } from "@/lib/tarefas/recorrencia";
import { conferirResponsavel } from "@/lib/tarefas/responsavel";
import {
  PRIORIDADES_DA_TAREFA,
  SITUACOES_DA_TAREFA,
  type Tarefa,
} from "@/lib/tarefas/tipos";
import type { McpToolDefinition } from "../types";

const VINCULO_INEXISTENTE = "O negócio, o contato ou a demanda vinculada não existe.";

/**
 * `ctx.supabase` é service role, e a chave estrangeira não passa pela RLS: sem
 * esta conferência, um `lead_id`/`contact_id` de outra organização gravaria sem
 * erro. A régua é a de `criarTarefaInterna` (`lib/tarefas/criar-tarefa.ts`):
 * SQL na porta, com a organização no filtro. Id inexistente e id de outra
 * organização recebem a MESMA recusa — a do 23503 abaixo.
 */
async function conferirVinculos(
  organizationId: string,
  vinculos: { lead_id?: string | null; contact_id?: string | null },
): Promise<void> {
  const conferencias = [
    ["crm_leads", vinculos.lead_id],
    ["contacts", vinculos.contact_id],
  ] as const;
  for (const [tabela, id] of conferencias) {
    if (!id) continue;
    let linha: { id: string } | null;
    try {
      linha = await portaDaAplicacao().queryOne<{ id: string }>(
        `select id from ${tabela} where id = $1 and organization_id = $2 limit 1`,
        [id, organizationId],
      );
    } catch {
      throw new Error("Erro interno ao validar os vínculos da tarefa.");
    }
    if (!linha) throw new Error(VINCULO_INEXISTENTE);
  }
}

const createInputShape = {
  title: z
    .string()
    .trim()
    .min(1, "Título é obrigatório")
    .max(255, "Título deve ter no máximo 255 caracteres"),
  description: z.string().max(5000, "Descrição deve ter no máximo 5000 caracteres").optional(),
  due_date: z.string().datetime({ offset: true }).optional(),
  priority: z.enum(PRIORIDADES_DA_TAREFA).default("medium"),
  contact_id: z.string().uuid("contact_id deve ser UUID válido").optional(),
  lead_id: z.string().uuid("lead_id deve ser UUID válido").optional(),
  demanda_id: z.string().uuid("demanda_id deve ser UUID válido").optional(),
  assigned_to: z.string().uuid("assigned_to deve ser UUID válido").optional(),
};

export const crmCreateTask: McpToolDefinition<typeof createInputShape> = {
  name: "crm_create_task",
  description:
    "Cria uma nova tarefa ou retorno interno vinculado a um cliente, atendimento ou negócio, com prazo e responsável.",
  inputSchema: createInputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    // 1. Validar pertencimento do responsável à organização se informado
    if (input.assigned_to) {
      const vereditoResp = await conferirResponsavel(
        portaDaAplicacao(),
        ctx.organizationId,
        input.assigned_to,
      );
      if (vereditoResp === "falha_na_consulta") {
        throw new Error("Erro interno ao validar o responsável da tarefa.");
      }
      if (vereditoResp === "fora_da_equipe") {
        throw new Error("O responsável informado não faz parte da equipe desta organização.");
      }
    }

    // 2. Validar demanda ativa se informada
    if (input.demanda_id) {
      const vereditoDemanda = await conferirDemanda(
        portaDaAplicacao(),
        ctx.organizationId,
        input.demanda_id,
      );
      if (vereditoDemanda === "falha_na_consulta") {
        throw new Error("Erro interno ao validar a demanda vinculada.");
      }
      if (vereditoDemanda === "fora_da_organizacao") {
        throw new Error("A demanda informada não pertence a esta organização ou não existe.");
      }
      if (vereditoDemanda === "encerrada") {
        throw new Error("A demanda informada já foi encerrada. Crie a tarefa em uma demanda ativa.");
      }
    }

    await conferirVinculos(ctx.organizationId, input);

    // 3. Inserir em public.crm_tasks
    const { data, error } = await ctx.supabase
      .from("crm_tasks")
      .insert({
        title: input.title,
        description: input.description ?? null,
        due_date: input.due_date ?? null,
        priority: input.priority,
        contact_id: input.contact_id ?? null,
        lead_id: input.lead_id ?? null,
        demanda_id: input.demanda_id ?? null,
        assigned_to: input.assigned_to ?? null,
        organization_id: ctx.organizationId,
        created_by: ctx.actor.type === "user" ? ctx.actor.id : null,
      })
      .select(
        "id, organization_id, title, description, due_date, priority, status, lead_id, contact_id, demanda_id, assigned_to, created_by, created_at, updated_at",
      )
      .single();

    if (error) {
      if (error.code === "23503") {
        throw new Error(VINCULO_INEXISTENTE);
      }
      throw new Error(`Erro ao salvar a tarefa: ${error.message}`);
    }

    // 4. Registro de auditoria
    await audit({
      action: "crm_task.created",
      actorUserId: ctx.actor.type === "user" ? (ctx.actor.id as string) : null,
      organizationId: ctx.organizationId,
      resourceType: "crm_tasks",
      resourceId: data.id,
      requestId: ctx.requestId,
      metadata: { due_date: data.due_date, priority: data.priority },
    });

    // 5. Linha do tempo do negócio (Sistema Vivo) se houver lead_id
    if (data.lead_id) {
      await registraAtividadeDaTarefa(portaDaAplicacao(), {
        organizationId: ctx.organizationId,
        tarefa: data as Tarefa,
        tipo: "task_created",
        actor: ctx.actor,
      });
    }

    return { task: data };
  },
};

const listInputShape = {
  status: z.enum(SITUACOES_DA_TAREFA).optional(),
  assigned_to: z.union([z.literal("me"), z.literal("ninguem"), z.string().uuid()]).optional(),
  contact_id: z.string().uuid("contact_id deve ser UUID válido").optional(),
  lead_id: z.string().uuid("lead_id deve ser UUID válido").optional(),
  demanda_id: z.string().uuid("demanda_id deve ser UUID válido").optional(),
  due_from: z.string().datetime().optional(),
  due_to: z.string().datetime().optional(),
  limite: z.number().int().min(1).max(100).default(50),
};

export const crmListTasks: McpToolDefinition<typeof listInputShape> = {
  name: "crm_list_tasks",
  description:
    "Lista tarefas pendentes ou filtradas da organização por responsável, contato, demanda ou período de vencimento.",
  inputSchema: listInputShape,
  category: "read",
  requiresRole: "viewer",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    let query = ctx.supabase
      .from("crm_tasks")
      .select(
        "id, organization_id, title, description, due_date, priority, status, lead_id, contact_id, demanda_id, assigned_to, created_by, created_at, updated_at, lead:crm_leads(id, title)",
      )
      .eq("organization_id", ctx.organizationId);

    if (input.status) {
      query = query.eq("status", input.status);
    }
    if (input.assigned_to) {
      if (input.assigned_to === "me") {
        if (ctx.actor.type === "user") {
          query = query.eq("assigned_to", ctx.actor.id);
        } else {
          return { tasks: [] };
        }
      } else if (input.assigned_to === "ninguem") {
        query = query.is("assigned_to", null);
      } else {
        query = query.eq("assigned_to", input.assigned_to);
      }
    }
    // No turno de atendimento, a lista é a do cliente da conversa: o título de
    // tarefa da equipe nomeia OUTROS clientes. Mesmo recorte das leituras de
    // `leads.ts` (#2158) — escopa quem a resposta alcança, não muda a pergunta.
    const contatoDoFiltro = ctx.contatoDoTurno ?? input.contact_id;
    if (contatoDoFiltro) {
      query = query.eq("contact_id", contatoDoFiltro);
    }
    if (input.lead_id) {
      query = query.eq("lead_id", input.lead_id);
    }
    if (input.demanda_id) {
      query = query.eq("demanda_id", input.demanda_id);
    }
    if (input.due_from) {
      query = query.gte("due_date", input.due_from);
    }
    if (input.due_to) {
      query = query.lte("due_date", input.due_to);
    }

    query = query
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(input.limite ?? 50);

    const { data, error } = await query;
    if (error) {
      throw new Error(`Erro ao listar tarefas: ${error.message}`);
    }

    return { tasks: data ?? [] };
  },
};

const updateInputShape = {
  task_id: z.string().uuid("task_id deve ser UUID válido"),
  title: z.string().trim().min(1, "Título não pode ser vazio").max(255).optional(),
  description: z.string().max(5000).nullable().optional(),
  due_date: z.string().datetime({ offset: true }).nullable().optional(),
  priority: z.enum(PRIORIDADES_DA_TAREFA).optional(),
  status: z.enum(SITUACOES_DA_TAREFA).optional(),
  assigned_to: z.string().uuid("assigned_to deve ser UUID válido").nullable().optional(),
  contact_id: z.string().uuid("contact_id deve ser UUID válido").nullable().optional(),
  lead_id: z.string().uuid("lead_id deve ser UUID válido").nullable().optional(),
  demanda_id: z.string().uuid("demanda_id deve ser UUID válido").nullable().optional(),
};

export const crmUpdateTask: McpToolDefinition<typeof updateInputShape> = {
  name: "crm_update_task",
  description:
    "Atualiza uma tarefa existente, permitindo alterar status (ex: done, in_progress), prazo, prioridade, responsável ou vínculos.",
  inputSchema: updateInputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { task_id, ...updates } = input;

    const camposParaAtualizar = Object.entries(updates).filter(
      ([_, v]) => v !== undefined,
    );
    if (camposParaAtualizar.length === 0) {
      throw new Error("Nenhum campo informado para atualização.");
    }

    // 1. Validar assigned_to se informado
    if (updates.assigned_to) {
      const vereditoResp = await conferirResponsavel(
        portaDaAplicacao(),
        ctx.organizationId,
        updates.assigned_to,
      );
      if (vereditoResp === "falha_na_consulta") {
        throw new Error("Erro interno ao validar o novo responsável da tarefa.");
      }
      if (vereditoResp === "fora_da_equipe") {
        throw new Error("O responsável informado não faz parte da equipe desta organização.");
      }
    }

    // 2. Validar demanda_id se informada
    if (updates.demanda_id) {
      const vereditoDemanda = await conferirDemanda(
        portaDaAplicacao(),
        ctx.organizationId,
        updates.demanda_id,
      );
      if (vereditoDemanda === "falha_na_consulta") {
        throw new Error("Erro interno ao validar a demanda vinculada.");
      }
      if (vereditoDemanda === "fora_da_organizacao") {
        throw new Error("A demanda informada não pertence a esta organização ou não existe.");
      }
      if (vereditoDemanda === "encerrada") {
        throw new Error("A demanda informada já foi encerrada.");
      }
    }

    await conferirVinculos(ctx.organizationId, updates);

    // A situação ANTES da edição decide se esta é a vez em que a tarefa fechou
    // (mesma régua da PATCH /api/v1/tasks/[id]): sem ler antes, concluir duas
    // vezes gravaria duas linhas `task_completed` na timeline do negócio.
    const { data: antes, error: erroDaLeitura } = await ctx.supabase
      .from("crm_tasks")
      .select("status, due_date")
      .eq("id", task_id)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();
    if (erroDaLeitura) {
      throw new Error(`Erro ao ler a tarefa: ${erroDaLeitura.message}`);
    }
    if (!antes) {
      throw new Error("Tarefa não encontrada nesta organização.");
    }
    const statusAntes = antes.status;

    // 3. Executar o UPDATE com filtro de isolamento por organization_id.
    // `updated_at` fica com o trigger `trg_crm_tasks_updated_at`.
    const dadosUpdate = Object.fromEntries(camposParaAtualizar);

    const { data, error } = await ctx.supabase
      .from("crm_tasks")
      .update(dadosUpdate)
      .eq("id", task_id)
      .eq("organization_id", ctx.organizationId)
      .select(
        "id, organization_id, title, description, due_date, priority, status, lead_id, contact_id, demanda_id, assigned_to, created_by, created_at, updated_at, recurrence_source_id",
      )
      .maybeSingle();

    if (error) {
      if (error.code === "23503") {
        throw new Error(VINCULO_INEXISTENTE);
      }
      throw new Error(`Erro ao atualizar a tarefa: ${error.message}`);
    }

    if (!data) {
      throw new Error("Tarefa não encontrada nesta organização.");
    }
    const { recurrence_source_id, ...tarefa } = data;

    // 4. Auditoria
    await audit({
      action: "crm_task.updated",
      actorUserId: ctx.actor.type === "user" ? (ctx.actor.id as string) : null,
      organizationId: ctx.organizationId,
      resourceType: "crm_tasks",
      resourceId: tarefa.id,
      requestId: ctx.requestId,
      // A transição só entra quando `status` veio: editar o título não grava
      // um `de: "pending", para: "pending"` que não existiu.
      metadata: {
        campos: camposParaAtualizar.map(([k]) => k),
        ...(updates.status !== undefined ? { de: statusAntes, para: tarefa.status } : {}),
      },
    });

    // Record completion and continue the series on the transition to done.
    if (tarefa.status === "done" && statusAntes !== "done") {
      const db = portaDaAplicacao();
      await registraAtividadeDaTarefa(db, {
        organizationId: ctx.organizationId,
        tarefa: tarefa as Tarefa,
        tipo: "task_completed",
        actor: ctx.actor,
      });
      await criarProximaSemDerrubar(db, {
        id: tarefa.id,
        organization_id: ctx.organizationId,
        recurrence_source_id: recurrence_source_id ?? null,
        due_date: tarefa.due_date ?? antes.due_date ?? null,
      });
    }

    return { task: tarefa };
  },
};
