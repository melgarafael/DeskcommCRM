import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/tasks — as tarefas da organização, em ordem de prazo.
 * POST /api/v1/tasks — cria uma tarefa.
 *
 * A ROTA É FINA. Ela autentica, valida a forma do corpo e traduz o resultado (ou
 * o `ApiError`) em resposta HTTP; a decisão mora em `./_handler.ts`, e a razão é
 * que uma ferramenta MCP não chama rota Next (#4516). Rota e tool chamam a MESMA
 * função — a integração por token não ganhou uma segunda regra de negócio.
 *
 * ─── O que o arquivo original recusou, e continua recusando ────────────────
 *
 *  1. **A lista de "agendamentos" derivada de `custom_fields`.** O PR #418
 *     varria `crm_leads` procurando `agendamento_data`, `agendamento_hora`,
 *     `procedimento` e `agendamento_status` e sintetizava itens com título
 *     `🗓️ Fulano (Limpeza)`. Para a clínica dele isso era a agenda inteira; num
 *     produto que já tem `calendar_appointments` (migration 0177) seria uma
 *     SEGUNDA verdade sobre o mesmo compromisso.
 *
 *  2. **O fallback para `custom_fields.tasks` quando a tabela não existe.** O
 *     original capturava `42P01`/`PGRST205` e passava a gravar as tarefas dentro
 *     do lead. Isso transforma "o banco desta instalação está desatualizado" em
 *     sucesso silencioso, com o dado indo para um lugar que nenhuma lista,
 *     índice ou policy alcança. A 0210 fechou a lacuna.
 *
 * ─── A PORTA DO TOKEN (#4516) ──────────────────────────────────────────────
 *
 * Sessão de navegador OU Bearer `dsk_…`, resolvidos por `lib/api/auth-dual.ts`
 * DENTRO da rota: a organização sai da LINHA DO TOKEN, nunca de query ou corpo.
 * `GET` cobra `tasks:read` e as escritas cobram `tasks:write` — escopos próprios,
 * e não `mcp:read`/`mcp:write`, porque quem emite o token decide se a integração
 * mexe na rotina da equipe. O caminho está em `lib/auth/public-paths.ts`; sem
 * essa entrada o proxy responde 401 antes de o Bearer chegar aqui.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ESCOPO_TAREFAS_ESCRITA, ESCOPO_TAREFAS_LEITURA } from "@/lib/api/escopos-do-token";
import type { Actor } from "@/lib/api/handlers/types";
import { chaveDaRequisicao } from "@/lib/api/idempotency";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { PRIORIDADES_DA_TAREFA, SITUACOES_DA_TAREFA } from "@/lib/tarefas/tipos";

import { LIMITE_MAXIMO_DA_LISTA, criarTarefaHandler, listarTarefasHandler } from "./_handler";

export const dynamic = "force-dynamic";

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
   * esconderia as que ficaram fora do corte).
   *
   * `me` NÃO existe para um token de integração: não há pessoa na linha do
   * token, e resolver para o id do próprio token devolveria lista vazia em
   * silêncio. Vira 422 nomeado, abaixo.
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
  limite: z.coerce.number().int().min(1).max(LIMITE_MAXIMO_DA_LISTA).optional(),
});

/** Traduz o `ApiError` do handler; `null` quer dizer "não é recusa de negócio". */
function traduzErro(
  err: unknown,
  t: (texto: string) => string,
  requestId: string,
): Response | null {
  if (!(err instanceof ApiError)) return null;
  return fail(err.code, t(err.message), err.status, {
    details: err.details as Record<string, unknown> | undefined,
    requestId,
  });
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_tasks",
    role: "viewer",
    scope: ESCOPO_TAREFAS_LEITURA,
    tokenRole: "viewer",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  const parsed = listaSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) {
    return fail("validation_failed", t("Parâmetros inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const filtros = parsed.data;

  if (filtros.assigned_to === "me" && authz.actor.type !== "user") {
    return fail(
      "validation_failed",
      t("O filtro por responsável atual exige uma pessoa; informe o id de um membro da equipe."),
      422,
      { requestId },
    );
  }

  try {
    const resultado = await listarTarefasHandler(
      authz.supabase,
      {
        organization_id: authz.organizationId,
        actor: authz.actor as Actor,
        requestId,
        ...(authz.apiTokenId !== undefined ? { apiTokenId: authz.apiTokenId } : {}),
      },
      {
        ...filtros,
        aberto: filtros.aberto === "true",
        sem_responsavel: filtros.assigned_to === "ninguem",
        ...(filtros.assigned_to === "ninguem" ? { assigned_to: undefined } : {}),
        ...(filtros.assigned_to === "me" && authz.actor.type === "user"
          ? { assigned_to: authz.actor.id, sem_responsavel: false }
          : {}),
      },
    );
    return ok(resultado, { requestId });
  } catch (err) {
    const resposta = traduzErro(err, t, requestId);
    if (resposta) return resposta;
    throw err;
  }
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
    scope: ESCOPO_TAREFAS_ESCRITA,
    tokenRole: "agent",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  /**
   * A CHAVE DE IDEMPOTÊNCIA (#4516) — o que impede a integração de duplicar a
   * tarefa quando repete a chamada. O mesmo header e as mesmas regras de
   * `/api/v1/agenda/agendamentos`: UUID, janela de 24h, mesmo corpo devolve o
   * recibo, corpo diferente dá 409 `idempotency_conflict`.
   */
  const idempotencyKey = chaveDaRequisicao(req);
  if (idempotencyKey !== null && !z.string().uuid().safeParse(idempotencyKey).success) {
    return fail("validation_failed", t("Idempotency-Key deve ser UUID"), 400, { requestId });
  }

  const tetoEstourado = await tetoDeEscritaDoToken(authz, "tasks", requestId);
  if (tetoEstourado) return tetoEstourado;

  const parsed = criacaoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  try {
    const resultado = await criarTarefaHandler(
      authz.supabase,
      {
        organization_id: authz.organizationId,
        actor: authz.actor as Actor,
        requestId,
        ...(idempotencyKey !== null ? { idempotencyKey } : {}),
        ...(authz.apiTokenId !== undefined ? { apiTokenId: authz.apiTokenId } : {}),
      },
      parsed.data,
    );
    return ok(resultado, { requestId, status: 201 });
  } catch (err) {
    const resposta = traduzErro(err, t, requestId);
    if (resposta) return resposta;
    throw err;
  }
}
