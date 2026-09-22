/**
 * Transições da rota (iniciar/finalizar) — a máquina mora num lugar só para
 * as duas rotas não divergirem nas regras.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

import { carregarCargaComParadas } from "./_carga";

export async function transicaoDeRota(
  _req: NextRequest,
  id: string,
  para: "iniciar" | "finalizar",
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "shipments" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const d = await carregarCargaComParadas(supabase, authz.org.orgId, id);
  if (!d) return fail("not_found", "Carga não encontrada.", 404, { requestId });

  if (para === "iniciar") {
    if (d.carga.status !== "montando") {
      return fail("validation_failed", "Só carga montando inicia rota.", 422, { requestId });
    }
    if (d.paradas.length === 0) {
      return fail("validation_failed", "Carga sem pedidos.", 422, { requestId });
    }
    const { error } = await supabase
      .from("shipments")
      .update({ status: "em_rota", started_at: new Date().toISOString(), started_by: authz.user.id })
      .eq("id", id)
      .eq("organization_id", authz.org.orgId);
    if (error) return fail("internal_error", "Erro ao iniciar a rota.", 500, { requestId });
    await supabase
      .from("shipment_orders")
      .update({ status: "em_rota" })
      .eq("shipment_id", id)
      .eq("organization_id", authz.org.orgId)
      .eq("status", "na_carga");
  } else {
    if (d.carga.status !== "em_rota") {
      return fail("validation_failed", "Só rota em andamento finaliza.", 422, { requestId });
    }
    // em_atendimento é pendência: chegou ≠ entregue.
    const pendentes = d.itens.filter((i) => ["na_carga", "em_rota", "em_atendimento"].includes(i.status)).length;
    if (pendentes > 0) {
      return fail("validation_failed", `${pendentes} parada(s) ainda sem desfecho (entregue ou devolvido).`, 422, {
        requestId,
      });
    }
    const { error } = await supabase
      .from("shipments")
      .update({ status: "concluida", finished_at: new Date().toISOString() })
      .eq("id", id)
      .eq("organization_id", authz.org.orgId);
    if (error) return fail("internal_error", "Erro ao finalizar a rota.", 500, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: para === "iniciar" ? "shipment.rota.iniciada" : "shipment.rota.finalizada",
    resourceType: "shipments",
    resourceId: id,
    requestId,
  });

  const atualizado = await carregarCargaComParadas(supabase, authz.org.orgId, id);
  return ok(atualizado, { requestId });
}
