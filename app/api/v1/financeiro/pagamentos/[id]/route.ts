/**
 * DELETE /api/v1/financeiro/pagamentos/[id] — estornar recebimento.
 *
 * Apaga o evento e recalcula o status do recebível (nunca deixa pago
 * fantasma). Manager+, com auditoria.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { estornarPagamento } from "@/lib/comercial/financeiro";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "financial_receivables" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  const admin = createAdminClient();
  let resultado: Awaited<ReturnType<typeof estornarPagamento>>;
  try {
    resultado = await estornarPagamento(admin, { orgId: authz.org.orgId, pagamentoId: id });
  } catch {
    return fail("internal_error", "Erro ao estornar.", 500, { requestId });
  }
  if (!resultado.ok) return fail("not_found", "Pagamento não encontrado.", 404, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "financial_payment.reversed",
    resourceType: "financial_payments",
    resourceId: id,
    requestId,
  });
  return ok({ novo_status: resultado.novoStatus }, { requestId });
}
