/**
 * POST /api/v1/invoices/[id]/reemitir — volta nota `erro` (ou `em_emissao`
 * travada) para a fila.
 *
 * Idempotente pela unique de job aberto: dois cliques criam um job só. Notas
 * terminais (autorizada/denegada/cancelada) e pendentes de stub recusam com
 * 422 nomeando o estado.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { podeTransitar } from "@/lib/fiscal/fila";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "invoices" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  const supabase = await createClient();
  const { data: nota } = await supabase
    .from("invoices")
    .select("id, status")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  const atual = nota as unknown as { id: string; status: string } | null;
  if (!atual) return fail("not_found", "Nota não encontrada.", 404, { requestId });
  if (!podeTransitar(atual.status, "em_emissao")) {
    return fail("validation_failed", `Nota ${atual.status} não pode voltar para emissão.`, 422, { requestId });
  }

  const { error: erroJob } = await supabase.from("fiscal_jobs").insert({
    organization_id: authz.org.orgId,
    invoice_id: id,
    tipo: "emitir",
    status: "pendente",
    created_by: authz.user.id,
  });
  // Job aberto já existe (duplo clique): reaproveita em vez de falhar.
  if (erroJob && erroJob.code !== "23505") {
    return fail("internal_error", "Erro ao enfileirar.", 500, { requestId });
  }
  const { error: erroNota } = await supabase
    .from("invoices")
    .update({ status: "em_emissao", erro: null })
    .eq("id", id)
    .eq("organization_id", authz.org.orgId);
  if (erroNota) return fail("internal_error", "Erro ao reabrir a nota.", 500, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "invoice.retry_requested",
    resourceType: "invoices",
    resourceId: id,
    requestId,
  });
  return ok({ id, status: "em_emissao" }, { requestId, status: 201 });
}
