/**
 * Remover um item da comanda.
 *
 * ⚠️ ESTE É O ÚNICO DELETE DO MÓDULO, e ele é legítimo: um item de comanda
 * ABERTA ainda não virou nada. Não há lançamento, não há comissão, não há ponto
 * de fidelidade — a finalização é que cria os três. Tirar um item digitado
 * errado antes de fechar é correção, não reescrita do passado.
 *
 * Depois de finalizada, o caminho é o ESTORNO. O guard abaixo é o que separa os
 * dois casos, e sem ele o mesmo verbo apagaria história.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; itemId: string }> };

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  // #1907 item 4 — comanda é MÓDULO DE TABELA: sem `modulos_instalados` a
  // linha ativa as cinco tabelas não existem e a rota não existe. 404,
  // mesmo molde da cobrança desligada (falha fechada, dois lados).
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "financeiro"))) return fail("not_found", "Not found", 404, { requestId });
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "financeiro",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "financeiro_comanda_item_remover", requestId);
  if (teto) return teto;

  const { id, itemId } = await ctx.params;
  const supabase = authz.supabase;

  const { data: comanda } = await supabase
    .from("sales")
    .select("id, status, number")
    .eq("id", id)
    .eq("organization_id", authz.organizationId)
    .maybeSingle();
  if (!comanda) return fail("not_found", "Comanda não encontrada.", 404, { requestId });
  if (comanda.status !== "open") {
    return fail(
      "conflict",
      comanda.status === "finalized"
        ? "Comanda já finalizada. Para desfazer, use o estorno."
        : "Comanda cancelada não aceita alteração.",
      409,
      { requestId },
    );
  }

  // `sale_id` no filtro além do `id`: sem ele, um itemId de OUTRA comanda da
  // mesma organização seria apagado por esta rota, e a RLS não veria problema
  // nenhum — as duas linhas pertencem ao mesmo tenant.
  const { data, error } = await supabase
    .from("sale_items")
    .delete()
    .eq("id", itemId)
    .eq("sale_id", id)
    .eq("organization_id", authz.organizationId)
    .select("id")
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", "Item não encontrado nesta comanda.", 404, { requestId });

  await audit({
    action: "comanda.item_removido",
    organizationId: authz.organizationId,
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    resourceType: "sale",
    resourceId: id,
    requestId,
    metadata: { number: comanda.number, item_id: itemId },
  });

  return ok({ id: itemId, removed: true }, { requestId });
}
