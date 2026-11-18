import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/leads/[id]/checklist/[tarefaId] — marca/desmarca UM item (#4717).
 *
 * Corpo: `{ "concluido": true | false }`.
 *
 * ─── Por que uma rota própria, e não o PATCH de `/tasks/[id]` ──────────────
 *
 * O PATCH de tarefa aceita qualquer tarefa da organização. O checklist tem um
 * escopo MENOR e mais duro: só se marca o que É item do checklist DESTE card.
 * Sem a rota própria, o painel viraria uma porta para concluir tarefa avulsa ou
 * de outro negócio passando um id — e o "checklist" deixaria de ser uma lista
 * fechada. A regra (e as três guardas) mora em `marcarItemDoChecklist`.
 *
 * O escopo do checklist SOMA à régua da sessão, não a substitui: a rota só
 * segue se a sessão vê o negócio (`negocioVisivel`), e a escrita do status vai
 * pelo client da sessão — a mesma permissão de escrita em tarefa que o PATCH de
 * `/tasks/[id]` respeita. A porta da aplicação só lê e grava a linha do tempo.
 *
 * A resposta devolve a LISTA INTEIRA recalculada no servidor. É o que permite ao
 * painel mostrar o estado do card — e não o que o clique achou que gravou — no
 * mesmo instante, sem recarregar a página.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { negocioVisivel } from "@/lib/cadencias/visibilidade";
import { portaDaAplicacao } from "@/lib/db";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { marcarItemDoChecklist } from "@/lib/tarefas/checklist";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const marcacaoSchema = z.object({
  /** `true` = concluir o item; `false` = reabrir (desmarcar). */
  concluido: z.boolean(),
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; tarefaId: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId, tarefaId } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "crm_tasks" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = marcacaoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const visivel = await negocioVisivel(authz.org.orgId, leadId);
  if (visivel === "erro") {
    return fail("internal_error", t("Erro ao marcar o item do checklist."), 500, { requestId });
  }
  if (!visivel) {
    return fail("resource_not_found", t("Item do checklist não encontrado."), 404, { requestId });
  }

  const sessao = await createClient();
  const resultado = await marcarItemDoChecklist(portaDaAplicacao(), {
    organizationId: authz.org.orgId,
    leadId,
    tarefaId,
    usuarioId: authz.user.id,
    concluido: parsed.data.concluido,
    origem: "tela:inbox",
  }, async (alvoId, alvo) => {
    // `.select` no update: sem ele, a recusa da régua de escrita é zero linhas
    // em silêncio, e a lib gravaria a conclusão de uma tarefa que não mudou.
    const { data, error } = await sessao
      .from("crm_tasks")
      .update({ status: alvo })
      .eq("id", alvoId)
      .eq("organization_id", authz.org.orgId)
      .eq("lead_id", leadId)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data !== null;
  });

  if (!resultado.ok) {
    if (resultado.codigo === "negocio_fora_do_escopo" || resultado.codigo === "item_fora_do_checklist") {
      return fail("resource_not_found", t("Item do checklist não encontrado."), 404, { requestId });
    }
    logger.error("[checklist/post] marcação falhou", {
      lead_id: leadId,
      tarefa_id: tarefaId,
      organization_id: authz.org.orgId,
      error: resultado.erro,
      requestId,
    });
    return fail("internal_error", t("Erro ao marcar o item do checklist."), 500, { requestId });
  }

  // O QUEM e o QUANDO do gesto: concluir já grava `task_completed` na linha do
  // tempo (com autor); o audit cobre o DESMARCAR, que não tem linha de timeline
  // própria nessa fase — e é o registro de quem voltou o item. Só quando o
  // status MUDOU, com `de`/`para`, como o PATCH de tarefa (#4028): clicar no que
  // já estava marcado não é mutação.
  if (resultado.anterior !== resultado.item.status) {
    await audit({
      organizationId: authz.org.orgId,
      actorUserId: authz.user.id,
      action: "crm_task.updated",
      resourceType: "crm_tasks",
      resourceId: tarefaId,
      requestId,
      metadata: {
        campos: ["status"],
        de: resultado.anterior,
        para: resultado.item.status,
        checklist: true,
        lead_id: leadId,
      },
    });
  }

  return ok({ checklist: resultado.checklist, item: resultado.item }, { requestId });
}
