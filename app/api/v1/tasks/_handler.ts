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
import { fusoDaOrganizacao } from "@/lib/automation/cron-de-data";
import { portaDaAplicacao } from "@/lib/db";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { registraAtividadeDaTarefa } from "@/lib/tarefas/atividade";
import { conferirDemanda } from "@/lib/tarefas/demanda";
import {
  anexarNegocioDaTarefa,
  COLUNAS_DA_TAREFA,
  conferirNegocioEContato,
} from "@/lib/tarefas/negocio-da-tarefa";
import { normalizarRegra, proximaOcorrencia, regraParaGravar } from "@/lib/tarefas/recorrencia";
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
  "id, organization_id, title, description, due_date, priority, status, lead_id, contact_id, demanda_id, assigned_to, created_by, recurrence, created_at, updated_at, lead:crm_leads(id, title)";

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
  /** Só as tarefas de quem é membro deste setor (#4630). */
  sector_id?: string;
  limite?: number;
}

/**
 * A regra da SÉRIE como ela CHEGA (#4595): `ativa` é opcional no corpo, e quem
 * completa o padrão é `normalizarRegra` — o mesmo motivo de o schema zod da
 * rota ter `ativa` opcional e o JSON gravado sempre explícito.
 */
export interface RegraDeSerieRecebida {
  dias: number[];
  hora: number;
  ativa?: boolean;
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
  /**
   * A SÉRIE (#4595). Presente = a tarefa criada é a SÉRIE e passa a gerar
   * ocorrências; `null` (ou ausente) = tarefa avulsa, como sempre foi.
   */
  recurrence?: RegraDeSerieRecebida | null;
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
  /**
   * A SÉRIE (#4595). `null` DESLIGA a repetição — a série para de gerar e as
   * ocorrências que já nasceram continuam na lista, como história.
   */
  recurrence?: RegraDeSerieRecebida | null;
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
  // `user` = sessão de navegador; qualquer outro ator (token de integração, agente
  // nativo pela tool MCP) cai na service role, onde a RLS não está no caminho.
  const doToken = ctx.actor.type !== "user";

  // O filtro de funil depende do embed `lead:crm_leads!inner`, e é o embed que a
  // service role transforma em vazamento: com ela o título do negócio de OUTRA
  // organização sairia na lista. Em vez de reabrir o embed, o token recebe 422 —
  // quem integra cruza por `lead_id` com `GET /api/v1/pipelines/[id]/leads`.
  if (doToken && filtros.pipeline_id) {
    throw new ApiError(
      422,
      "validation_failed",
      { pipeline_id: ["Este filtro só vale para quem entrou pela tela; use `lead_id`."] },
      ctx.requestId,
      "Parâmetros inválidos.",
    );
  }

  // ⚠️ `organization_id` à mão mesmo com RLS ligada: é a regra do CLAUDE.md, e
  // ela não é redundante — pelo MCP o client é service-role e a RLS não vale.
  let query = supabase
    .from("crm_tasks")
    .select(
      doToken ? COLUNAS_DA_TAREFA : filtros.pipeline_id ? COLUNAS_NO_FUNIL : COLUNAS,
    )
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

  if (filtros.sector_id) {
    // Setores é módulo opcional (doc 213): desligado, o filtro não existe —
    // a mesma resposta das rotas de setor, em vez de filtrar por um dado que a
    // instalação não mostra.
    if (!(await moduloLigado(createAdminClient(), "setores"))) {
      throw new ApiError(404, "not_found", undefined, ctx.requestId, "Not found.");
    }
    const { data: membrosDoSetor, error: erroDoSetor } = await supabase
      .from("attendant_sector_members")
      .select("user_id")
      .eq("sector_id", filtros.sector_id)
      .eq("organization_id", ctx.organization_id);
    if (erroDoSetor) {
      throw new ApiError(500, "internal_error", undefined, ctx.requestId, "Erro ao listar as tarefas.");
    }
    const ids = (membrosDoSetor ?? []).map((m: { user_id: string }) => m.user_id);
    // Setor sem ninguém: nenhuma tarefa é dele.
    if (ids.length === 0) return { tasks: [] };
    query = query.in("assigned_to", ids);
  }

  const { data, error } = await query;
  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, "Erro ao listar as tarefas.");
  }

  const tarefas = (data ?? []) as unknown as Tarefa[];
  // Pela sessão o embed já trouxe o negócio (e a RLS de `crm_leads` decidiu o que
  // podia aparecer). Pelo token a lista veio SEM embed: o negócio é juntado aqui,
  // em consulta própria filtrada pela organização.
  if (!doToken) return { tasks: tarefas };

  const comNegocio = await anexarNegocioDaTarefa(supabase, ctx.organization_id, tarefas);
  if (!comNegocio) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, "Erro ao listar as tarefas.");
  }
  return { tasks: comNegocio };
}

/**
 * O responsável, a demanda, o negócio e o contato têm FK que a RLS não cobre:
 * sem conferir, um id de fora da organização GRAVARIA sem erro. A conferência
 * vale igual para a tela e para o token — é a mesma regra, no mesmo lugar.
 *
 * O negócio e o contato vão pelo client da chamada (`negocio-da-tarefa.ts`): ali
 * a consulta filtra a organização, então a resposta vem certa nos DOIS caminhos,
 * e no ramo do token a service role não vira porta dos fundos. Responsável e
 * demanda continuam no SQL direto de `lib/db` (`responsavel.ts`, `demanda.ts`),
 * que não passa por RLS e por isso também escreve o `organization_id` à mão.
 */
async function confereVinculos(
  supabase: SB,
  ctx: HandlerCtx,
  input: {
    assigned_to?: string | null;
    demanda_id?: string | null;
    lead_id?: string | null;
    contact_id?: string | null;
  },
): Promise<void> {
  if (input.lead_id || input.contact_id) {
    const veredito = await conferirNegocioEContato(supabase, ctx.organization_id, input);
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
  }

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

  const doToken = ctx.actor.type !== "user";

  const executar = async (): Promise<{ task: Tarefa }> => {
    await confereVinculos(supabase, ctx, input);

    // ═══ A SÉRIE QUE SE REPETE (#4595) ═══
    //
    // A regra vira o JSON normalizado que a varredura lê (`dias` filtrados e
    // ordenados, `hora` inteira, `ativa` explícita). E, quando a pessoa não
    // escolheu data, a PRIMEIRA ocorrência já nasce calculada no fuso da
    // organização: deixar para o primeiro cron faria a tarefa aparecer sem prazo
    // por até dez minutos — tempo de sobra para a pessoa concluir que não salvou.
    //
    // O fuso é o da ORGANIZAÇÃO, e `instanteDe` (dentro de `proximaOcorrencia`) é
    // quem converte hora de parede em instante. Calcular em UTC colocaria a
    // ligação das 9h às 6h de Brasília.
    //
    // ⚠️ A decisão mora AQUI, e não na rota, pelo mesmo motivo do #4516: a tool
    // MCP cria tarefa pela mesma função, e série com duas regras (uma para a
    // tela, outra para o token) divergiria no primeiro ajuste.
    let recurrence: ReturnType<typeof regraParaGravar> | null = null;
    let dueDate = input.due_date ?? null;
    if (input.recurrence) {
      const regra = normalizarRegra(input.recurrence);
      if (!regra) {
        throw new ApiError(
          422,
          "validation_failed",
          undefined,
          ctx.requestId,
          "Escolha pelo menos um dia da semana e um horário.",
        );
      }
      recurrence = regraParaGravar(regra);
      if (!dueDate) {
        const [organizacao] = await portaDaAplicacao().query<{ timezone: string | null }>(
          "select timezone from organizations where id = $1 limit 1",
          [ctx.organization_id],
        );
        const proxima = proximaOcorrencia(regra, new Date(), fusoDaOrganizacao(organizacao?.timezone));
        dueDate = proxima ? proxima.toISOString() : null;
      }
    }

    const { data, error } = await supabase
      .from("crm_tasks")
      .insert({
        ...input,
        due_date: dueDate,
        recurrence,
        organization_id: ctx.organization_id,
        created_by: pessoaDoAtor(ctx.actor),
      })
      .select(doToken ? COLUNAS_DA_TAREFA : COLUNAS)
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

    // A tarefa já está gravada: se a junção do negócio falhar, a resposta sai
    // com `lead: null` em vez de um 500 que convidaria o cliente a criar de novo.
    if (!doToken) return { task: tarefa };
    const comNegocio = await anexarNegocioDaTarefa(supabase, ctx.organization_id, [tarefa]);
    return { task: comNegocio?.[0] ?? { ...tarefa, lead: null } };
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
  const doToken = ctx.actor.type !== "user";
  await confereVinculos(supabase, ctx, campos);

  // A situação ANTES da edição decide se esta é a vez em que a tarefa fechou.
  // Sem ler antes, marcar "concluída" duas vezes emitiria duas linhas na
  // timeline do negócio — e a segunda seria mentira.
  //
  // ⚠️ LEITURA QUE FALHA NÃO É "NÃO HAVIA ANTES". Com `antes` nulo a edição
  // seguia, `fechouAgora` dava verdadeiro e o histórico do negócio ganhava uma
  // conclusão que não aconteceu; o audit ainda gravava `de: null`. O conserto
  // da main (1a9bb42465) devolvia 500 na rota; desde que a regra saiu da rota
  // (#4516) ele mora AQUI, e os dois caminhos — tela e token — passam por este
  // ponto.
  const { data: antes, error: erroDaLeitura } = await supabase
    .from("crm_tasks")
    .select("status")
    .eq("id", id)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();

  if (erroDaLeitura) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, "Erro ao salvar a tarefa.");
  }

  // ═══ A SÉRIE: desligar é gravar `null` (#4595) ═══
  //
  // A tela manda a regra inteira de volta quando a pessoa muda dias ou hora, e
  // `null` quando ela desmarca "repetir". Normalizar aqui é o que impede o JSON
  // torto de chegar ao banco: dia fora de 0–6 ou lista vazia é recusa nomeada,
  // não série que nunca gera.
  const alteracao: Record<string, unknown> = { ...campos };
  if (campos.recurrence !== undefined) {
    if (campos.recurrence === null) {
      alteracao.recurrence = null;
    } else {
      const regra = normalizarRegra(campos.recurrence);
      if (!regra) {
        throw new ApiError(
          422,
          "validation_failed",
          undefined,
          ctx.requestId,
          "Escolha pelo menos um dia da semana e um horário.",
        );
      }
      alteracao.recurrence = regraParaGravar(regra);
    }
  }

  const { data, error } = await supabase
    .from("crm_tasks")
    .update(alteracao)
    .eq("id", id)
    .eq("organization_id", ctx.organization_id)
    .select(doToken ? COLUNAS_DA_TAREFA : COLUNAS)
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

  // Mesma régua da criação: pelo token o `lead` não veio por embed, e um erro na
  // junção não pode transformar uma edição JÁ GRAVADA em 500.
  if (!doToken) return { task: tarefa };
  const comNegocio = await anexarNegocioDaTarefa(supabase, ctx.organization_id, [tarefa]);
  return { task: comNegocio?.[0] ?? { ...tarefa, lead: null } };
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
