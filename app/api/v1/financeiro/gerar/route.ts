/**
 * POST /api/v1/financeiro/gerar {order_id} — gera os recebíveis do pedido.
 *
 * Idempotente: parcela já gerada é pulada (unique parcial), então pode ser
 * chamado ao faturar E pelo botão "Gerar financeiro" sem duplicar. NF
 * opcional: se o pedido já tem invoice vinculada, ela é ligada.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { gerarRecebiveis } from "@/lib/comercial/financeiro";
import { gerarFinanceiroSchema } from "@/lib/schemas/financeiro";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "financial_receivables" });
  if (!authz.ok) return authz.response;

  const parsed = gerarFinanceiroSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, { requestId });
  }

  const supabase = await createClient();
  const { data: pedido } = await supabase
    .from("commercial_orders")
    .select("id, contact_id, total_cents, condicao_pagamento, created_at, status")
    .eq("organization_id", authz.org.orgId)
    .eq("id", parsed.data.order_id)
    .maybeSingle();
  const p = pedido as unknown as {
    id: string;
    contact_id: string | null;
    total_cents: number;
    condicao_pagamento: string | null;
    created_at: string;
    status: string;
  } | null;
  if (!p) return fail("not_found", "Pedido não encontrado.", 404, { requestId });
  if (p.status === "cancelado") {
    return fail("validation_failed", "Pedido cancelado não gera financeiro.", 422, { requestId });
  }
  if (p.status === "rascunho") {
    return fail("validation_failed", "Rascunho não gera financeiro — confirme o pedido antes.", 422, { requestId });
  }

  const admin = createAdminClient();
  let resultado: Awaited<ReturnType<typeof gerarRecebiveis>>;
  try {
    resultado = await gerarRecebiveis(admin, {
      orgId: authz.org.orgId,
      orderId: p.id,
      contactId: p.contact_id,
      totalCents: p.total_cents,
      condicao: p.condicao_pagamento,
      baseIso: p.created_at,
      criadoPor: authz.user.id,
    });
  } catch {
    return fail("internal_error", "Erro ao gerar recebíveis.", 500, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "financial_receivable.generated",
    resourceType: "commercial_orders",
    resourceId: p.id,
    requestId,
  });
  return ok(resultado, { requestId, status: 201 });
}
