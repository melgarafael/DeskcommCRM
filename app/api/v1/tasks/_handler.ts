/**
 * A REGRA DAS TAREFAS — fora da rota, de propósito (#4516).
 *
 * ⚠️ UMA FERRAMENTA MCP NÃO CHAMA ROTA NEXT. Não há `request`, não há cookie, e
 * a rota devolve `Response` em vez de dado. Por isso o repo tem o padrão do
 * `_handler` (agenda, messages, conversations, contacts, leads, pipelines): a
 * regra mora aqui, e a ROTA e a TOOL chamam a MESMA função. As tarefas eram a
 * exceção, com a regra inline nas duas rotas — e por isso a integração por token
 * não tinha o que embrulhar sem reescrever a regra num segundo lugar.
 *
 * ⚠️ A ORGANIZAÇÃO ENTRA POR PARÂMETRO (`ctx.organization_id`), nunca resolvida
 * aqui. A rota tira do cookie validado ou da LINHA DO TOKEN; a tool, do contexto
 * do agente. Pelo MCP o client é service-role e a RLS não vale, então
 * `organization_id` vai explícito em TODA query — sem isso o token de uma
 * organização alcançaria a tarefa de outra e a leitura não devolveria erro
 * (só passaria a "saber" o que não é da casa dele).
 *
 * ⚠️ `created_by` É FK PARA `auth.users`. Ator que não é pessoa (token de
 * integração) grava `null` — a coluna recebia o id do TOKEN e o INSERT morria em
 * `violates foreign key constraint`, o mesmo defeito medido em
 * `POST /api/v1/messages`. Quem agiu fica no audit (`actor_api_token_id`), que é
 * o lugar certo para identidade que não é usuário.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { comIdempotencia, hashDoCorpo } from "@/lib/api/idempotency";
import type { Actor, HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { portaDaAplicacao } from "@/lib/db";
import { registraAtividadeDaTarefa } from "@/lib/tarefas/atividade";
import { conferirDemanda } from "@/lib/tarefas/demanda";
import { conferirResponsavel } from "@/lib/tarefas/responsavel";
import {
  SITUACOES_ABERTAS_DA_TAREFA,
  type PrioridadeDaTarefa,
  type SituacaoDaTarefa,
  type Tarefa,
} from "@/lib/tarefas/tipos";

type SB = SupabaseClient;

/** O teto da lista — e o máximo que `?limite=` aceita. */
export const LIMITE_MAXIMO_DA_LISTA = 500;

/** As colunas que a tela lê. Explícitas para o `select *` não vazar coluna nova. */
const COLUNAS =
  "id, organization_id, title, description, due_date, priority, status, lead_id, contact_id, demanda_id, assigned_to, created_by, created_at, updated_at, lead:crm_leads(id, title)";

/**
 * Com o filtro de funil o `lead` vira INNER JOIN: o PostgREST só filtra pela
 * coluna de um recurso embutido se o embutido for obrigatório; com o join comum
 * a tarefa de outro funil continuaria na lista, só que com `lead: null`. Sem o
 * filtro a consulta é a de sempre — o join obrigatório esconderia as tarefas
 * soltas (sem negócio), que são caso real.
 */
const COLUNAS_NO_FUNIL = COLUNAS.replace("lead:crm_leads(", "lead:crm_leads!inner(");

const ENDPOINT_IDEMPOTENCIA_TAREFAS = "/api/v1/tasks";

export interface FiltrosDaLista {
  status?: SituacaoDaTarefa;
  priority?: PrioridadeDaTarefa;
  lead_id?: string;
  contact_id?: string;
  demanda_id?: string;
  due_from?: string;
  due_to?: string;
  aberto?: boolean;
  /** Id de membro já resolvido pela rota: `me` não existe para um token. */
  assigned_to?: string;
  /** `?assigned_to=ninguem` — tarefa sem responsável. */
  sem_responsavel?: boolean;
  pipeline_id?: string;
  limite?: number;
}

export interface CriacaoDaTarefa {
  title: string;
  description?: string | null;
  due_date?: string | null;
  priority: PrioridadeDaTarefa;
  status: SituacaoDaTarefa;
  lead_id?: string | null;
  contact_id?: string | null;
  demanda_id?: string | null;
  assigned_to?: string | null;
}

export interface EdicaoDaTarefa {
  id: string;
  title?: string;
  description?: string | null;
  due_date?: string | null;
  priority?: PrioridadeDaTarefa;
  status?: SituacaoDaTarefa;
  lead_id?: string | null;
  contact_id?: string | null;
  demanda_id?: string | null;
  assigned_to?: string | null;
}

/** Quem assina o audit: pessoa, ou a linha do token quando não há pessoa. */
function autorDoAudit(ctx: HandlerCtx): {
  actorUserId: string | null;
  actorApiTokenId: string | null;
} {
  if (ctx.actor.type === "user") {
    return { actorUserId: ctx.actor.id, actorApiTokenId: null };
  }
  if (ctx.apiTokenId) return { actorUserId: null, actorApiTokenId: ctx.apiTokenId };
  if (ctx.actor.type === "ai_agent") {
    return { actorUserId: null, actorApiTokenId: ctx.actor.api_token_id ?? null };
  }
  if (ctx.actor.type === "api_token") {
    return { actorUserId: null, actorApiTokenId: ctx.actor.id };
  }
  return { actorUserId: null, actorApiTokenId: null };
}

/** O ator que assina a linha da timeline; `created_by` só aceita pessoa. */
function pessoaDoAtor(actor: Actor): string | null {
  return actor.type === "user" ? actor.id : null;
}

export async function listarTarefasHandler(
  supabase: SB,
  ctx: HandlerCtx,
  filtros: FiltrosDaLista,
): Promise<{ tasks: Tarefa[] }> {
  // ⚠️ `organization_id` à mão mesmo com RLS ligada: é a regra do CLAUDE.md, e
  // ela não é redundante — pelo MCP o client é service-role e a RLS não vale.
  let query = supabase
    .from("crm_tasks")
    .select(filtros.pipeline_id ? COLUNAS_NO_FUNIL : COLUNAS)
    .eq("organization_id", ctx.organization_id)
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(filtros.limite ?? LIMITE_MAXIMO_DA_LISTA);

  if (filtros.status) query = query.eq("status", filtros.status);
  if (filtros.priority) query = query.eq("priority", filtros.priority);
  if (filtros.lead_id) query = query.eq("lead_id", filtros.lead_id);
  if (filtros.contact_id) query = query.eq("contact_id", filtros.contact_id);
  if (filtros.demanda_id) query = query.eq("demanda_id", filtros.demanda_id);
  if (filtros.due_from) query = query.gte("due_date", filtros.due_from);
  if (filtros.due_to) query = query.lte("due_date", filtros.due_to);
  if (filtros.aberto === true) query = query.in("status", [...SITUACOES_ABERTAS_DA_TAREFA]);
  if (filtros.sem_responsavel) query = query.is("assigned_to", null);
  else if (filtros.assigned_to) query = query.eq("assigned_to", filtros.assigned_to);
  if (filtros.pipeline_id) query = query.eq("lead.pipeline_id", filtros.pipeline_id);

  const { data, error } = await query;
  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, "Erro ao listar as tarefas.");
  }

  return { tasks: (data ?? []) as unknown as Tarefa[] };
}

/**
 * O responsável e a demanda têm FK que a RLS não cobre (`lib/tarefas/responsavel.ts`
 * e `demanda.ts` fazem SQL direto na porta de `lib/db`): sem conferir, um id de
 * fora da organização GRAVARIA sem erro. A conferência vale igual para a tela e
 * para o token — é a mesma regra, no mesmo lugar.
 */
async function confereVinculos(
  ctx: HandlerCtx,
  input: { assigned_to?: string | null; demanda_id?: string | null },
): Promise<void> {
  if (input.assigned_to) {
    const veredito = await conferirResponsavel(portaDaAplicacao(), ctx.organization_id, input.assigned_to);
    if (veredito === "falha_na_consulta") {
      throw new ApiError(500, "internal_error", undefined, ctx.requestId, "Erro ao salvar a tarefa.");
    }
    if (veredito === "fora_da_equipe") {
      throw new ApiError(422, "validation_failed", undefined, ctx.requestId, "O responsável escolhido não faz parte da equipe.");
    }
  }

  if (input.demanda_id) {
    const veredito = await conferirDemanda(portaDaAplicacao(), ctx.organization_id, input.demanda_id);
    if (veredito === "falha_na_consulta") {
      throw new ApiError(500, "internal_error", undefined, ctx.requestId, "Erro ao salvar a tarefa.");
    }
    if (veredito === "fora_da_organizacao") {
      throw new ApiError(
        422,
        "validation_failed",
        undefined,
        ctx.requestId,
        "O negócio, o contato ou a demanda vinculada não existe.",
      );
    }
    if (veredito === "encerrada") {
      throw new ApiError(
        409,
        "state_conflict",
        undefined,
        ctx.requestId,
        "Esta demanda já foi encerrada. Crie a tarefa numa demanda em andamento.",
      );
    }
  }
}

export async function criarTarefaHandler(
  supabase: SB,
  ctx: HandlerCtx,
  input: CriacaoDaTarefa,
): Promise<{ task: Tarefa }> {
  /**
   * A CHAVE DE IDEMPOTÊNCIA VALE PARA O TOKEN E PARA A TELA (#4516).
   *
   * Repetir a criação com a mesma chave não pode gerar duas tarefas: quem chama
   * de fora retenta por rede, por timeout, por job que reencaminhou. A reserva e
   * o recibo são os de `lib/api/idempotency.ts` (a MESMA implementação de
   * `/api/v1/agenda/agendamentos`), com endpoint próprio para o balde não se
   * misturar com o da agenda.
   *
   * Sem chave, o comportamento é o de sempre: cria. A régua é do cliente.
   */
  const chave =
    ctx.idempotencyKey ??
    (ctx.sourceJobId ? `agent-job:${ctx.sourceJobId}:${hashDoCorpo(input)}` : null);

  const executar = async (): Promise<{ task: Tarefa }> => {
    await confereVinculos(ctx, input);

    const { data, error } = await supabase
      .from("crm_tasks")
      .insert({
        ...input,
        organization_id: ctx.organization_id,
        created_by: pessoaDoAtor(ctx.actor),
      })
      .select(COLUNAS)
      .single();

    if (error) {
      // 23503 = negócio, contato ou demanda apagado no meio, entre a escolha e a
      // gravação. A recusa nomeia os campos porque quem lê é quem escolheu na tela.
      if (error.code === "23503") {
        throw new ApiError(
          422,
          "validation_failed",
          undefined,
          ctx.requestId,
          "O negócio, o contato ou a demanda vinculada não existe.",
        );
      }
      throw new ApiError(500, "internal_error", undefined, ctx.requestId, "Erro ao salvar a tarefa.");
    }

    const tarefa = data as unknown as Tarefa;
    const autor = autorDoAudit(ctx);

    await audit({
      organizationId: ctx.organization_id,
      actorUserId: autor.actorUserId,
      actorApiTokenId: autor.actorApiTokenId,
      action: "crm_task.created",
      resourceType: "crm_tasks",
      resourceId: tarefa.id,
      requestId: ctx.requestId,
      metadata: {
        due_date: tarefa.due_date,
        priority: tarefa.priority,
        ...(ctx.actor.type === "user" ? {} : { via: "token" }),
      },
    });

    // O laço de retorno: tarefa presa a um negócio aparece na linha do tempo dele.
    await registraAtividadeDaTarefa(portaDaAplicacao(), {
      organizationId: ctx.organization_id,
      tarefa,
      tipo: "task_created",
      actor: ctx.actor,
    });

    return { task: tarefa };
  };

  if (chave === null) return executar();

  const desfecho = await comIdempotencia({
    db: supabase,
    organizationId: ctx.organization_id,
    endpoint: ENDPOINT_IDEMPOTENCIA_TAREFAS,
    chave,
    corpo: input,
    executar: async () => ({ resposta: await executar(), status: 201 }),
  });

  if (desfecho.tipo === "conflito") {
    throw new ApiError(
      409,
      "idempotency_conflict",
      undefined,
      ctx.requestId,
      "Esta chave de idempotência já foi usada com outro conteúdo.",
    );
  }
  if (desfecho.tipo === "em_curso") {
    throw new ApiError(
      409,
      "idempotency_in_progress",
      undefined,
      ctx.requestId,
      "A mesma requisição ainda está em curso. Tente de novo em instantes.",
    );
  }
  return desfecho.resposta;
}

export async function editarTarefaHandler(
  supabase: SB,
  ctx: HandlerCtx,
  input: EdicaoDaTarefa,
): Promise<{ task: Tarefa }> {
  const { id, ...campos } = input;
  await confereVinculos(ctx, campos);

  // A situação ANTES da edição decide se esta é a vez em que a tarefa fechou.
  // Sem ler antes, marcar "concluída" duas vezes emitiria duas linhas na
  // timeline do negócio — e a segunda seria mentira.
  const { data: antes } = await supabase
    .from("crm_tasks")
    .select("status")
    .eq("id", id)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();

  const { data, error } = await supabase
    .from("crm_tasks")
    .update(campos)
    .eq("id", id)
    .eq("organization_id", ctx.organization_id)
    .select(COLUNAS)
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      throw new ApiError(404, "not_found", undefined, ctx.requestId, "Tarefa não encontrada.");
    }
    if (error.code === "23503") {
      throw new ApiError(
        422,
        "validation_failed",
        undefined,
        ctx.requestId,
        "O negócio, o contato ou a demanda vinculada não existe.",
      );
    }
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, "Erro ao salvar a tarefa.");
  }

  const tarefa = data as unknown as Tarefa;

  /**
   * A TRANSIÇÃO, quando houve uma (#4028). O `campos` dizia QUAIS campos
   * mudaram, não PARA ONDE; sem `de`/`para` o audit responde "alguém tocou nesta
   * tarefa" a quem pergunta "quem a concluiu, e quando".
   */
  const transicao =
    campos.status !== undefined
      ? { de: (antes as { status?: string } | null)?.status ?? null, para: tarefa.status }
      : {};

  const autor = autorDoAudit(ctx);

  await audit({
    organizationId: ctx.organization_id,
    actorUserId: autor.actorUserId,
    actorApiTokenId: autor.actorApiTokenId,
    action: "crm_task.updated",
    resourceType: "crm_tasks",
    resourceId: tarefa.id,
    requestId: ctx.requestId,
    metadata: {
      campos: Object.keys(campos),
      ...transicao,
      ...(ctx.actor.type === "user" ? {} : { via: "token" }),
    },
  });

  const fechouAgora =
    tarefa.status === "done" && (antes as { status?: string } | null)?.status !== "done";
  if (fechouAgora) {
    await registraAtividadeDaTarefa(portaDaAplicacao(), {
      organizationId: ctx.organization_id,
      tarefa,
      tipo: "task_completed",
      actor: ctx.actor,
    });
  }

  return { task: tarefa };
}

export async function excluirTarefaHandler(
  supabase: SB,
  ctx: HandlerCtx,
  input: { id: string },
): Promise<{ deleted: true }> {
  // `.select()` no delete para saber se ALGUMA linha saiu. Sem isso, apagar uma
  // tarefa de outra organização devolveria 200 — e a tela sumiria com a linha do
  // próprio usuário na próxima recarga, sem que nada tivesse sido apagado.
  const { data, error } = await supabase
    .from("crm_tasks")
    .delete()
    .eq("id", input.id)
    .eq("organization_id", ctx.organization_id)
    .select("id");

  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, "Erro ao apagar a tarefa.");
  }
  if (!data || data.length === 0) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Tarefa não encontrada.");
  }

  const autor = autorDoAudit(ctx);

  await audit({
    organizationId: ctx.organization_id,
    actorUserId: autor.actorUserId,
    actorApiTokenId: autor.actorApiTokenId,
    action: "crm_task.deleted",
    resourceType: "crm_tasks",
    resourceId: input.id,
    requestId: ctx.requestId,
    ...(ctx.actor.type === "user" ? {} : { metadata: { via: "token" } }),
  });

  return { deleted: true };
}
