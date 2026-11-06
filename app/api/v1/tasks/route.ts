import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/tasks — as tarefas da organização, em ordem de prazo.
 * POST /api/v1/tasks — cria uma tarefa.
 *
 * Extraído do PR #418 (@clinicacentrodosorrisosc-code). Duas coisas do original
 * NÃO vieram, e as duas por motivo escrito:
 *
 *  1. **A lista de "agendamentos" derivada de `custom_fields`.** O GET original
 *     varria `crm_leads` procurando `agendamento_data`, `agendamento_hora`,
 *     `procedimento` e `agendamento_status` e sintetizava itens com título
 *     `🗓️ Fulano (Limpeza)`. Para a clínica dele isso era a agenda inteira; num
 *     produto que já tem `calendar_appointments` (migration 0177) seria uma
 *     SEGUNDA verdade sobre o mesmo compromisso, alimentada por um jsonb sem
 *     schema — e escrita em vocabulário de um nicho só.
 *
 *  2. **O fallback para `custom_fields.tasks` quando a tabela não existe.** O
 *     original capturava `42P01`/`PGRST205` e passava a gravar as tarefas dentro
 *     do lead. Isso existia porque lá a tabela vivia só no `baseline.sql`, sem
 *     migration — quem aplicasse `migrations/` não a teria. Aqui a 0210 fecha
 *     essa lacuna, e o fallback vira o pior tipo de rede: ele transforma "o
 *     banco desta instalação está desatualizado" em sucesso silencioso, com o
 *     dado indo para um lugar que nenhuma lista, índice ou policy alcança.
 *     Falhar aberto na INFORMAÇÃO é o certo aqui: 500 com a mensagem do banco.
 *
 * ─── Sessão OU token (Spec 33, R2) ─────────────────────────────────────────
 *
 * As duas portas entram por `resolveAuthDual`: a sessão do navegador com o
 * mesmo papel de sempre (viewer lê, agent cria), ou o Bearer `dsk_…` com
 * `mcp:read`/`mcp:write` e a organização vinda da LINHA DO TOKEN.
 *
 * No ramo do token o cliente é a service role, e a RLS deixa de proteger:
 *  - o `.eq("organization_id", …)` de cada cadeia é a única barreira;
 *  - o embed `lead:crm_leads(…)` sai da leitura e o negócio é juntado em
 *    consulta própria, filtrada pela organização (`negocio-da-tarefa.ts`);
 *  - `lead_id` e `contact_id` do corpo são conferidos na organização antes de
 *    gravar, como já são `demanda_id` e `assigned_to`;
 *  - `assigned_to=me` não existe: token não é pessoa, e o responsável é
 *    sempre um id de `auth.users`. Quem integra usa o id do responsável;
 *  - `created_by` só recebe id de pessoa — nunca o id do token.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { portaDaAplicacao } from "@/lib/db";
import { registraAtividadeDaTarefa } from "@/lib/tarefas/atividade";
import { conferirDemanda } from "@/lib/tarefas/demanda";
import {
  anexarNegocioDaTarefa,
  COLUNAS_DA_TAREFA,
  conferirNegocioEContato,
} from "@/lib/tarefas/negocio-da-tarefa";
import { conferirResponsavel } from "@/lib/tarefas/responsavel";
import {
  PRIORIDADES_DA_TAREFA,
  SITUACOES_ABERTAS_DA_TAREFA,
  SITUACOES_DA_TAREFA,
  type Tarefa,
} from "@/lib/tarefas/tipos";

export const dynamic = "force-dynamic";

/**
 * O teto da lista — e o máximo que `?limite=` aceita. Está nomeado porque agora
 * tem dois leitores (o default do `.limit()` e a validação do parâmetro): o dia
 * em que um deles mudar sozinho, a rota passaria a aceitar mais do que serve.
 */
const LIMITE_MAXIMO = 500;

/** As colunas que a tela lê. Explícitas para o `select *` não vazar coluna nova. */
const COLUNAS =
  "id, organization_id, title, description, due_date, priority, status, lead_id, contact_id, demanda_id, assigned_to, created_by, created_at, updated_at, lead:crm_leads(id, title)";

/**
 * Com o filtro de funil o `lead` vira INNER JOIN: o PostgREST só filtra pela coluna de um
 * recurso embutido se o embutido for obrigatório; com o join comum a tarefa de outro funil
 * continuaria na lista, só que com `lead: null`. Sem o filtro a consulta é a de sempre — o
 * join obrigatório esconderia as tarefas soltas (sem negócio), que são caso real.
 */
const COLUNAS_NO_FUNIL = COLUNAS.replace("lead:crm_leads(", "lead:crm_leads!inner(");

const criacaoSchema = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().max(5000).nullable().optional(),
  due_date: z.string().datetime({ offset: true }).nullable().optional(),
  priority: z.enum(PRIORIDADES_DA_TAREFA).default("medium"),
  status: z.enum(SITUACOES_DA_TAREFA).default("pending"),
  lead_id: z.string().uuid().nullable().optional(),
  contact_id: z.string().uuid().nullable().optional(),
  // O vínculo com o ASSUNTO do atendimento (#2818): é o que faz a tarefa
  // criada de dentro da conversa voltar para a tela de quem precisa cumpri-la.
  // Opcional como os outros dois — a tarefa avulsa é caso real.
  demanda_id: z.string().uuid().nullable().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
});

const listaSchema = z.object({
  status: z.enum(SITUACOES_DA_TAREFA).optional(),
  priority: z.enum(PRIORIDADES_DA_TAREFA).optional(),
  lead_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
  /** As tarefas de UMA demanda — a seção "Tarefas desta demanda" do inbox. */
  demanda_id: z.string().uuid().optional(),
  due_from: z.string().datetime({ offset: true }).optional(),
  due_to: z.string().datetime({ offset: true }).optional(),
  /** "abertas" = o que ainda pede ação. É o default da tela. */
  aberto: z.enum(["true", "false"]).optional(),
  /**
   * De QUEM é a tarefa: `me` (o usuário da sessão, resolvido aqui), `ninguem`
   * (sem responsável) ou o id de um membro. Sem isto a tela de Tarefas misturava
   * a equipe inteira numa lista só (a lista corta em 500 — filtrar na tela
   * esconderia as que ficaram fora do corte). Um id de terceiro vindo do
   * navegador só ESTREITA uma lista que viewer+ já vê inteira; a organização sai
   * da sessão (ou da linha do token) e o `.eq("organization_id")` segura o resto.
   * `me` só existe para quem é uma pessoa: o token recebe 422.
   */
  assigned_to: z.union([z.literal("me"), z.literal("ninguem"), z.string().uuid()]).optional(),
  /**
   * Só as tarefas de negócios DESTE funil (`crm_leads.pipeline_id`). A tarefa não tem funil
   * próprio: ela herda o do negócio a que está presa, então tarefa solta fica de fora quando
   * o filtro está ligado. Um id de outra organização não devolve nada — o `organization_id`
   * da consulta e a RLS continuam valendo.
   */
  pipeline_id: z.string().uuid().optional(),
  /**
   * Teto de linhas desta busca (#4028). Existe porque a visão em QUADRO desenha
   * todas as colunas de uma vez e pediria a base inteira: ela manda um número
   * menor que o teto da lista. O máximo é DAQUI, não do navegador — um cliente
   * que peça mais que `LIMITE_MAXIMO` recebe 422 em vez de uma consulta do
   * tamanho que ele quiser.
   */
  limite: z.coerce.number().int().min(1).max(LIMITE_MAXIMO).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_tasks",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  // Está em PUBLIC_PATHS: o Bearer chega aqui sem estrangulamento a montante, e
  // o teto por token e por organização é o único que conta as chamadas.
  const teto = await tetoDeEscritaDoToken(authz, "crm_tasks", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const organizationId = authz.organizationId;
  const doToken = authz.via === "token";

  const parsed = listaSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) {
    return fail("validation_failed", t("Parâmetros inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const filtros = parsed.data;

  // `me` é a PESSOA da sessão. Token não é pessoa: não há "minhas tarefas" a
  // resolver, e adivinhar um responsável seria devolver a lista de outro.
  let responsavel: string | undefined = filtros.assigned_to;
  if (responsavel === "me") {
    if (authz.actor.type !== "user") {
      return fail("validation_failed", t("Parâmetros inválidos."), 422, {
        requestId,
        details: { assigned_to: ["`me` só vale para quem entrou pela tela; use o id do responsável ou `ninguem`."] },
      });
    }
    responsavel = authz.actor.id;
  }

  // O filtro de funil só existe com o negócio EMBUTIDO (`lead:crm_leads!inner`),
  // e o embed é exatamente o que o ramo do token não usa: com a service role ele
  // não passa pela RLS de `crm_leads` e devolveria negócio de outra organização.
  // Em vez de reabrir o embed, o token recebe 422 — quem precisa do funil filtra
  // pelos negócios (`GET /api/v1/pipelines/[id]/leads`) e cruza por `lead_id`.
  if (doToken && filtros.pipeline_id) {
    return fail("validation_failed", t("Parâmetros inválidos."), 422, {
      requestId,
      details: { pipeline_id: ["Este filtro só vale para quem entrou pela tela; use `lead_id`."] },
    });
  }

  const supabase = authz.supabase;
  // No ramo do token o negócio NÃO vem por embed (service role não passa pela RLS
  // de `crm_leads`): ele é juntado abaixo, em consulta filtrada pela organização.
  const colunas: string = doToken
    ? COLUNAS_DA_TAREFA
    : filtros.pipeline_id
      ? COLUNAS_NO_FUNIL
      : COLUNAS;
  // ⚠️ `organization_id` à mão mesmo com RLS ligada: é a regra do CLAUDE.md, e
  // no ramo do token (admin client, que bypassa RLS) é a ÚNICA barreira.
  let query = supabase
    .from("crm_tasks")
    .select(colunas)
    .eq("organization_id", organizationId)
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(filtros.limite ?? LIMITE_MAXIMO);

  if (filtros.status) query = query.eq("status", filtros.status);
  if (filtros.priority) query = query.eq("priority", filtros.priority);
  if (filtros.lead_id) query = query.eq("lead_id", filtros.lead_id);
  if (filtros.contact_id) query = query.eq("contact_id", filtros.contact_id);
  if (filtros.demanda_id) query = query.eq("demanda_id", filtros.demanda_id);
  if (filtros.due_from) query = query.gte("due_date", filtros.due_from);
  if (filtros.due_to) query = query.lte("due_date", filtros.due_to);
  if (filtros.aberto === "true") query = query.in("status", [...SITUACOES_ABERTAS_DA_TAREFA]);
  if (responsavel === "ninguem") query = query.is("assigned_to", null);
  else if (responsavel) query = query.eq("assigned_to", responsavel);
  if (filtros.pipeline_id) query = query.eq("lead.pipeline_id", filtros.pipeline_id);

  const { data, error } = await query;
  if (error) {
    return fail("internal_error", t("Erro ao listar as tarefas."), 500, { requestId });
  }

  const tarefas = (data ?? []) as unknown as Tarefa[];
  if (!doToken) return ok({ tasks: tarefas }, { requestId });

  const comNegocio = await anexarNegocioDaTarefa(supabase, organizationId, tarefas);
  if (!comNegocio) {
    return fail("internal_error", t("Erro ao listar as tarefas."), 500, { requestId });
  }
  return ok({ tasks: comNegocio }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // `agent` e não `manager`: criar tarefa é o gesto de quem ATENDE, todo dia.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_tasks",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "crm_tasks", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const organizationId = authz.organizationId;
  const doToken = authz.via === "token";
  // `created_by` tem FK para `auth.users`: o id de um token não é pessoa e
  // violaria a chave. Só a sessão (ou um ator `user`) assina a tarefa.
  const autorId = authz.actor.type === "user" ? authz.actor.id : null;

  const parsed = criacaoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  if (parsed.data.assigned_to) {
    // A chave estrangeira de `assigned_to` é só para `auth.users`: sem esta conferência, um id de
    // outra organização (ou de quem saiu da equipe) gravaria sem erro. A régua
    // e o porquê do filtro de organização estão em `lib/tarefas/responsavel.ts`
    // (SQL direto na porta de `lib/db` — o pool NÃO passa por RLS).
    const veredito = await conferirResponsavel(
      portaDaAplicacao(),
      organizationId,
      parsed.data.assigned_to,
    );
    if (veredito === "falha_na_consulta") {
      return fail("internal_error", t("Erro ao salvar a tarefa."), 500, { requestId });
    }
    if (veredito === "fora_da_equipe") {
      return fail("validation_failed", t("O responsável escolhido não faz parte da equipe."), 422, {
        requestId,
      });
    }
  }

  const supabase = authz.supabase;

  if (doToken) {
    // Na sessão a RLS esconde o negócio de outra organização; a service role não.
    // O token só prende a tarefa a negócio e contato da PRÓPRIA organização.
    const vinculos = await conferirNegocioEContato(supabase, organizationId, parsed.data);
    if (vinculos === "falha_na_consulta") {
      return fail("internal_error", t("Erro ao salvar a tarefa."), 500, { requestId });
    }
    if (vinculos === "fora_da_organizacao") {
      return fail("validation_failed", t("O negócio, o contato ou a demanda vinculada não existe."), 422, {
        requestId,
      });
    }
  }

  if (parsed.data.demanda_id) {
    // A chave estrangeira não passa pela RLS: sem esta conferência, a demanda
    // de outra organização gravaria sem erro. A régua está em `lib/tarefas/demanda.ts`.
    const veredito = await conferirDemanda(
      portaDaAplicacao(),
      organizationId,
      parsed.data.demanda_id,
    );
    if (veredito === "falha_na_consulta") {
      return fail("internal_error", t("Erro ao salvar a tarefa."), 500, { requestId });
    }
    if (veredito === "fora_da_organizacao") {
      return fail("validation_failed", t("O negócio, o contato ou a demanda vinculada não existe."), 422, {
        requestId,
      });
    }
    if (veredito === "encerrada") {
      return fail("state_conflict", t("Esta demanda já foi encerrada. Crie a tarefa numa demanda em andamento."), 409, {
        requestId,
      });
    }
  }

  const { data, error } = await supabase
    .from("crm_tasks")
    .insert({
      ...parsed.data,
      organization_id: organizationId,
      created_by: autorId,
    })
    .select(doToken ? COLUNAS_DA_TAREFA : COLUNAS)
    .single();

  if (error) {
    // 23503 = negócio, contato ou demanda apagado no meio, entre a escolha e a
    // gravação. A recusa nomeia os campos porque quem lê é quem escolheu na tela.
    if (error.code === "23503") {
      return fail("validation_failed", t("O negócio, o contato ou a demanda vinculada não existe."), 422, {
        requestId,
      });
    }
    return fail("internal_error", t("Erro ao salvar a tarefa."), 500, { requestId });
  }

  const gravada = data as unknown as Tarefa;

  await audit({
    organizationId,
    actorUserId: autorId,
    actorApiTokenId: authz.apiTokenId ?? null,
    action: "crm_task.created",
    resourceType: "crm_tasks",
    resourceId: gravada.id,
    requestId,
    metadata: { due_date: gravada.due_date, priority: gravada.priority },
  });

  // O laço de retorno: tarefa presa a um negócio aparece na linha do tempo dele.
  await registraAtividadeDaTarefa(portaDaAplicacao(), {
    organizationId,
    tarefa: gravada,
    tipo: "task_created",
    actor: authz.actor,
  });

  // A tarefa já está gravada: se a junção do negócio falhar, a resposta sai
  // com `lead: null` em vez de um 500 que convidaria o cliente a criar de novo.
  const tarefa = doToken
    ? ((await anexarNegocioDaTarefa(supabase, organizationId, [gravada]))?.[0] ?? { ...gravada, lead: null })
    : gravada;

  return ok({ task: tarefa }, { requestId, status: 201 });
}
