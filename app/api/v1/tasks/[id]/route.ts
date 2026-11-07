import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/tasks/[id] — edita uma tarefa.
 * DELETE /api/v1/tasks/[id] — apaga uma tarefa.
 *
 * Extraído do PR #418 (@clinicacentrodosorrisosc-code), sem o fallback para
 * `custom_fields.tasks` — o motivo inteiro está no cabeçalho de
 * `app/api/v1/tasks/route.ts`.
 *
 * ⚠️ O `.eq("organization_id", ...)` não é decoração: sem ele o PATCH casaria
 * 0 linhas numa tarefa de outra organização e o PostgREST devolveria `PGRST116`
 * — que esta rota já traduz para 404, o desfecho certo. Mantê-lo explícito é a
 * regra do CLAUDE.md e o que segura o dia em que alguém trocar o client.
 *
 * ─── Sessão OU token (Spec 33, R2) ─────────────────────────────────────────
 *
 * As duas portas entram por `resolveAuthDual` (agent+; `mcp:write` no token).
 * No ramo do token o cliente é a service role e a RLS não protege mais: o
 * `.eq("organization_id", …)` de CADA cadeia daqui é a única barreira, o negócio
 * da resposta é juntado em consulta própria (`negocio-da-tarefa.ts`, o embed da
 * sessão não passa pela RLS de `crm_leads`) e o negócio/contato do corpo são
 * conferidos na organização antes de gravar. Mais detalhes em `../route.ts`.
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
import { PRIORIDADES_DA_TAREFA, SITUACOES_DA_TAREFA, type Tarefa } from "@/lib/tarefas/tipos";

export const dynamic = "force-dynamic";

const COLUNAS =
  "id, organization_id, title, description, due_date, priority, status, lead_id, contact_id, demanda_id, assigned_to, created_by, created_at, updated_at, lead:crm_leads(id, title)";

const edicaoSchema = z
  .object({
    title: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(5000).nullable().optional(),
    due_date: z.string().datetime({ offset: true }).nullable().optional(),
    priority: z.enum(PRIORIDADES_DA_TAREFA).optional(),
    status: z.enum(SITUACOES_DA_TAREFA).optional(),
    lead_id: z.string().uuid().nullable().optional(),
    contact_id: z.string().uuid().nullable().optional(),
    /** Vincular (`<uuid>`) e desvincular (`null`) a demanda do atendimento (#2818). */
    demanda_id: z.string().uuid().nullable().optional(),
    assigned_to: z.string().uuid().nullable().optional(),
  })
  // PATCH vazio gravaria só o `updated_at` e devolveria 200: a tela diria
  // "salvo" sobre uma edição que não existiu.
  .refine((v) => Object.keys(v).length > 0, { message: "Nada para alterar." });

interface Contexto {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: Contexto): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

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

  const parsed = edicaoSchema.safeParse(await req.json().catch(() => null));
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
    // O token só prende a tarefa a negócio e contato da PRÓPRIA organização
    // (`null` desvincula e passa).
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

  // A situação ANTES da edição decide se esta é a vez em que a tarefa fechou.
  // Sem ler antes, marcar "concluída" duas vezes emitiria duas linhas na
  // timeline do negócio — e a segunda seria mentira.
  const { data: antes } = await supabase
    .from("crm_tasks")
    .select("status")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  const { data, error } = await supabase
    .from("crm_tasks")
    .update(parsed.data)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select(doToken ? COLUNAS_DA_TAREFA : COLUNAS)
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      return fail("not_found", t("Tarefa não encontrada."), 404, { requestId });
    }
    if (error.code === "23503") {
      return fail("validation_failed", t("O negócio, o contato ou a demanda vinculada não existe."), 422, {
        requestId,
      });
    }
    return fail("internal_error", t("Erro ao salvar a tarefa."), 500, { requestId });
  }

  const gravada = data as unknown as Tarefa;

  /*
   * A TRANSIÇÃO, quando houve uma (#4028).
   *
   * O `campos` dizia QUAIS campos mudaram, não PARA ONDE. Para o quadro isso é
   * o registro que importa: arrastar o cartão é a única ação da tela de Tarefas
   * que muda o estado da linha, e sem `de`/`para` o audit responderia "alguém
   * tocou nesta tarefa" a quem perguntasse "quem a concluiu, e quando". O
   * QUANDO é o `created_at` da própria linha de audit; o QUEM é o ator.
   *
   * Só entra quando `status` veio no corpo: editar o título não pode gravar uma
   * transição que não existiu (`de: "pending", para: "pending"`).
   */
  const transicao =
    parsed.data.status !== undefined
      ? { de: (antes as { status?: string } | null)?.status ?? null, para: gravada.status }
      : {};

  await audit({
    organizationId,
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    action: "crm_task.updated",
    resourceType: "crm_tasks",
    resourceId: gravada.id,
    requestId,
    metadata: { campos: Object.keys(parsed.data), ...transicao },
  });

  const fechouAgora =
    gravada.status === "done" && (antes as { status?: string } | null)?.status !== "done";
  if (fechouAgora) {
    await registraAtividadeDaTarefa(portaDaAplicacao(), {
      organizationId,
      tarefa: gravada,
      tipo: "task_completed",
      actor: authz.actor,
    });
  }

  // A edição já está gravada: se a junção do negócio falhar, a resposta sai
  // com `lead: null` em vez de um 500 que convidaria o cliente a repetir.
  const tarefa = doToken
    ? ((await anexarNegocioDaTarefa(supabase, organizationId, [gravada]))?.[0] ?? { ...gravada, lead: null })
    : gravada;

  return ok({ task: tarefa }, { requestId });
}

export async function DELETE(req: NextRequest, ctx: Contexto): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

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

  const supabase = authz.supabase;
  // `.select()` no delete para saber se ALGUMA linha saiu. Sem isso, apagar uma
  // tarefa de outra organização devolveria 200 — e a tela sumiria com a linha
  // do próprio usuário na próxima recarga, sem que nada tivesse sido apagado.
  const { data, error } = await supabase
    .from("crm_tasks")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id");

  if (error) {
    return fail("internal_error", t("Erro ao apagar a tarefa."), 500, { requestId });
  }
  if (!data || data.length === 0) {
    return fail("not_found", t("Tarefa não encontrada."), 404, { requestId });
  }

  await audit({
    organizationId,
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    action: "crm_task.deleted",
    resourceType: "crm_tasks",
    resourceId: id,
    requestId,
  });

  return ok({ deleted: true }, { requestId });
}
