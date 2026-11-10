import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const code = url.searchParams.get("code");

  const supabase = await createClient();
  let query = supabase
    .from("finance_gift_cards")
    .select("*, finance_gift_card_transactions(*)")
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });

  if (status) query = query.eq("status", status);
  if (code) query = query.ilike("code", `%${code}%`);

  const { data, error } = await query;
  if (error) return fail("db_error", error.message, 500, { requestId });

  const cards = data ?? [];
  const totalBalance = cards
    .filter((gc) => gc.status === "active")
    .reduce((sum, gc) => sum + (gc.current_balance ?? 0), 0);

  return ok(cards, {
    requestId,
    meta: {
      total: cards.length,
      active_count: cards.filter((gc) => gc.status === "active").length,
      total_balance: totalBalance,
    },
  });
}

export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg, user } = authz;

  const body = await req.json().catch(() => null);
  if (!body?.initial_amount || body.initial_amount <= 0) {
    return fail("validation", "initial_amount must be greater than 0", 422, { requestId });
  }

  const supabase = await createClient();

  const code = body.code ?? generateCode();

  const { data: existing } = await supabase
    .from("finance_gift_cards")
    .select("id")
    .eq("organization_id", activeOrg.orgId)
    .eq("code", code)
    .single();

  if (existing) {
    return fail("conflict", "Ya existe una tarjeta con ese código", 409, { requestId });
  }

  const { data, error } = await supabase
    .from("finance_gift_cards")
    .insert({
      organization_id: activeOrg.orgId,
      code,
      initial_amount: body.initial_amount,
      current_balance: body.initial_amount,
      status: "active",
      purchased_by: body.purchased_by ?? null,
      assigned_to: body.assigned_to ?? null,
      sale_id: body.sale_id ?? null,
      expires_at: body.expires_at ?? null,
      notes: body.notes ?? null,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) return fail("db_error", error.message, 500, { requestId });

  await supabase.from("finance_gift_card_transactions").insert({
    gift_card_id: data.id,
    transaction_type: "credit",
    amount: body.initial_amount,
    balance_after: body.initial_amount,
    description: "Carga inicial",
    created_by: user.id,
  });

  return ok(data, { status: 201, requestId });
}

function generateCode(): string {
  const year = new Date().getFullYear();
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const random = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `GC-${year}-${random}`;
}
