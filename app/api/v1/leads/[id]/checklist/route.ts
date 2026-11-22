/**
 * GET /api/v1/leads/[id]/checklist — o plano aplicado como LISTA ÚNICA do card (#4717).
 *
 * É a leitura do painel do card no Inbox: a lista na ordem do plano, o estado
 * de cada item, quem marcou e quando, e o progresso ("3 de 7 concluídas" é
 * composto na TELA — rótulo é interface e passa por `t()`).
 *
 * ─── O que esta rota NÃO faz ───────────────────────────────────────────────
 *
 * Não há tabela de checklist: os itens SÃO as tarefas que o plano criou, e a
 * origem da lista é a marca `task_plan_applied` que a aplicação já gravava.
 * O motivo inteiro, com o custo declarado, está no cabeçalho de
 * `lib/tarefas/checklist.ts`.
 *
 * `viewer` é o piso: ver o checklist é ver o card, a mesma régua da lista do
 * funil. Escrever é `agent`+, na rota irmã `.../checklist/[tarefaId]`.
 *
 * A organização vem SEMPRE da sessão (`authz.org.orgId`) — nunca da URL. Um id
 * de negócio de outra organização não é lista vazia: é 404, porque quem não vê
 * o negócio não vê o checklist. "Ver o negócio" é a régua da SESSÃO
 * (`negocioVisivel`), não só a organização: a leitura abaixo usa a porta da
 * aplicação, que não passa por ela.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { negocioVisivel } from "@/lib/cadencias/visibilidade";
import { portaDaAplicacao } from "@/lib/db";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { lerChecklistDoNegocio } from "@/lib/tarefas/checklist";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("viewer", { requestId, resource: "crm_tasks" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const visivel = await negocioVisivel(authz.org.orgId, id);
  if (visivel === "erro") {
    return fail("internal_error", t("Erro interno. Tente de novo em instantes."), 500, { requestId });
  }
  if (!visivel) {
    return fail("resource_not_found", t("Negócio não encontrado."), 404, { requestId });
  }

  const resultado = await lerChecklistDoNegocio(portaDaAplicacao(), {
    organizationId: authz.org.orgId,
    leadId: id,
  });

  if (!resultado.ok) {
    if (resultado.codigo === "negocio_fora_do_escopo") {
      // O código do recorte não vaza para a resposta: para quem não vê o
      // negócio, ele simplesmente não existe.
      return fail("resource_not_found", t("Negócio não encontrado."), 404, { requestId });
    }
    logger.error("[checklist/get] leitura do checklist falhou", {
      lead_id: id,
      organization_id: authz.org.orgId,
      error: resultado.erro,
      requestId,
    });
    return fail("internal_error", t("Erro interno. Tente de novo em instantes."), 500, { requestId });
  }

  return ok({ checklist: resultado.checklist }, { requestId });
}
