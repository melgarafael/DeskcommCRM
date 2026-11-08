import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const createPaymentSchema = z.object({
  partner_id: z.string().uuid(),
  amount: z.number().positive(),
  payment_date: z.string().min(1),
  payment_type: z.string().min(1),
  journal_id: z.string().uuid(),
  entry_id: z.string().uuid().optional(),
  memo: z.string().optional(),
});

// GET /api/v1/finance/payments
export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const { searchParams } = new URL(req.url);
  const state = searchParams.get("state");
  const paymentType = searchParams.get("payment_type");
  const dateFrom = searchParams.get("date_from");
  const dateTo = searchParams.get("date_to");
  const limit = Math.min(Number(searchParams.get("limit") ?? "50") || 50, 200);

  const supabase = await createClient();
  let query = supabase
    .from("finance_payments")
    .select("id, partner_id, amount, payment_date, payment_type, state, journal_id, organization_id")
    .eq("organization_id", activeOrg.orgId)
    .order("payment_date", { ascending: false })
    .limit(limit);

  if (state) query = query.eq("state", state);
  if (paymentType) query = query.eq("payment_type", paymentType);
  if (dateFrom) query = query.gte("payment_date", dateFrom);
  if (dateTo) query = query.lte("payment_date", dateTo);

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data ?? [], { requestId, meta: { has_more: (data?.length ?? 0) === limit } });
}

// POST /api/v1/finance/payments — register payment via RPC
export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("validation_error", "Invalid JSON body", 400, { requestId });
  }

  const parsed = createPaymentSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Invalid request body", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema("finance").rpc("register_payment", {
    p_organization_id: activeOrg.orgId,
    p_partner_id: parsed.data.partner_id,
    p_amount: parsed.data.amount,
    p_payment_date: parsed.data.payment_date,
    p_payment_type: parsed.data.payment_type,
    p_journal_id: parsed.data.journal_id,
    ...(parsed.data.entry_id ? { p_entry_id: parsed.data.entry_id } : {}),
    ...(parsed.data.memo ? { p_memo: parsed.data.memo } : {}),
  });

  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data, { status: 201, requestId });
}
