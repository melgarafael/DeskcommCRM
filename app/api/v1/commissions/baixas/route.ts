/**
 * POST   /api/v1/commissions/baixas — registra o pagamento ("Dar Baixa", manager+).
 * DELETE /api/v1/commissions/baixas?order_id= — estorna a baixa (manager+).
 *
 * Um pedido, uma baixa (unique da 0226): pagar duas vezes é erro de dinheiro,
 * então o POST repete de forma idempotente quando a baixa já existe.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const baixaSchema = z.object({
  order_id: z.string().uuid(),
  valor_cents: z.number().int().min(0).max(1_000_000_000_00).optional(),
  observacao: z.string().trim().max(500).optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "commercial_commission_baixas" });
  if (!authz.ok) return authz.response;

  const parsed = baixaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  const { data: pedido } = await supabase
    .from("commercial_orders")
    .select("id, numero, total_cents, vendedor_user_id")
    .eq("id", parsed.data.order_id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!pedido) return fail("not_found", "Pedido não encontrado.", 404, { requestId });
  const ped = pedido as unknown as { id: string; total_cents: number; vendedor_user_id: string | null };

  const { data, error } = await supabase
    .from("commercial_commission_baixas")
    .upsert(
      {
        organization_id: authz.org.orgId,
        order_id: ped.id,
        vendedor_user_id: ped.vendedor_user_id,
        valor_cents: parsed.data.valor_cents ?? 0,
        baixado_por: authz.user.id,
        observacao: parsed.data.observacao ?? null,
      },
      { onConflict: "organization_id,order_id" },
    )
    .select("id, order_id, valor_cents, baixado_em")
    .single();
  if (error || !data) return fail("internal_error", "Erro ao dar baixa.", 500, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "commercial_commission.baixada",
    resourceType: "commercial_commission_baixas",
    resourceId: (data as { id: string }).id,
    requestId,
  });

  return ok(data, { requestId });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "commercial_commission_baixas" });
  if (!authz.ok) return authz.response;

  const orderId = req.nextUrl.searchParams.get("order_id")?.trim() ?? "";
  if (!orderId) return fail("validation_failed", "Passe ?order_id=.", 422, { requestId });

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("commercial_commission_baixas")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("order_id", orderId)
    .select("id");
  if (error) return fail("internal_error", "Erro ao estornar a baixa.", 500, { requestId });
  if (!data || (data as unknown[]).length === 0) {
    return fail("not_found", "Baixa não encontrada.", 404, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "commercial_commission.estornada",
    resourceType: "commercial_commission_baixas",
    resourceId: null,
    requestId,
    metadata: { actor_type: "user", order_id: orderId },
  });

  return ok({ order_id: orderId }, { requestId });
}
