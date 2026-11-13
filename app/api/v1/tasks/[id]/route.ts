import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/tasks/[id] — edita uma tarefa (inclusive concluir e reabrir).
 * DELETE /api/v1/tasks/[id] — apaga uma tarefa.
 *
 * Extraído do PR #418 (@clinicacentrodosorrisosc-code), sem o fallback para
 * `custom_fields.tasks` — o motivo inteiro está no cabeçalho de
 * `app/api/v1/tasks/route.ts`.
 *
 * A ROTA É FINA (#4516): autentica, valida a forma e traduz. A decisão mora em
 * `../_handler.ts`, que é a MESMA função que a ferramenta MCP chama — foi assim
 * que a integração por token ganhou a porta sem uma segunda regra de negócio.
 *
 * ⚠️ O `.eq("organization_id", ...)` não é decoração e agora está DENTRO do
 * handler: sem ele o PATCH casaria 0 linhas numa tarefa de outra organização e o
 * PostgREST devolveria `PGRST116` — que o handler já traduz para 404, o desfecho
 * certo. Pelo MCP o client é service-role e a RLS não vale, então o filtro
 * explícito é a ÚNICA coisa que separa uma organização da outra.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ESCOPO_TAREFAS_ESCRITA } from "@/lib/api/escopos-do-token";
import type { Actor } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { PRIORIDADES_DA_TAREFA, SITUACOES_DA_TAREFA } from "@/lib/tarefas/tipos";

import { editarTarefaHandler, excluirTarefaHandler } from "../_handler";

export const dynamic = "force-dynamic";

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

export async function PATCH(req: NextRequest, ctx: Contexto): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_tasks",
    role: "agent",
    scope: ESCOPO_TAREFAS_ESCRITA,
    tokenRole: "agent",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  const parsed = edicaoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const tetoEstourado = await tetoDeEscritaDoToken(authz, "tasks", requestId);
  if (tetoEstourado) return tetoEstourado;

  try {
    const resultado = await editarTarefaHandler(
      authz.supabase,
      {
        organization_id: authz.organizationId,
        actor: authz.actor as Actor,
        requestId,
        ...(authz.apiTokenId !== undefined ? { apiTokenId: authz.apiTokenId } : {}),
      },
      { id, ...parsed.data },
    );
    return ok(resultado, { requestId });
  } catch (err) {
    const resposta = traduzErro(err, t, requestId);
    if (resposta) return resposta;
    throw err;
  }
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
    scope: ESCOPO_TAREFAS_ESCRITA,
    tokenRole: "agent",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  const tetoEstourado = await tetoDeEscritaDoToken(authz, "tasks", requestId);
  if (tetoEstourado) return tetoEstourado;

  try {
    const resultado = await excluirTarefaHandler(
      authz.supabase,
      {
        organization_id: authz.organizationId,
        actor: authz.actor as Actor,
        requestId,
        ...(authz.apiTokenId !== undefined ? { apiTokenId: authz.apiTokenId } : {}),
      },
      { id },
    );
    return ok(resultado, { requestId });
  } catch (err) {
    const resposta = traduzErro(err, t, requestId);
    if (resposta) return resposta;
    throw err;
  }
}
