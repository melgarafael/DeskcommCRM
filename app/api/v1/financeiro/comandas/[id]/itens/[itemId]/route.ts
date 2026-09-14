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

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; itemId: string }> };

export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const { id, itemId } = await ctx.params;
  const supabase = await createClient();

  const { data: comanda } = await supabase
    .from("sales")
    .select("id, status, number")
    .eq("id", id)
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
    .select("id")
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", "Item não encontrado nesta comanda.", 404, { requestId });

  await audit({
    action: "comanda.item_removido",
    resourceType: "sale",
    resourceId: id,
    requestId,
    metadata: { number: comanda.number, item_id: itemId },
  });

  return ok({ id: itemId, removed: true }, { requestId });
}
