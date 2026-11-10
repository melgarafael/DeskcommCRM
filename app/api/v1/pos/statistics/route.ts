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
  const dateFrom = url.searchParams.get("date_from");
  const dateTo = url.searchParams.get("date_to");

  if (!dateFrom || !dateTo) {
    return fail("validation", "date_from and date_to are required", 422, { requestId });
  }

  const supabase = await createClient();

  const { data: salesData } = await supabase
    .from("finance_sales")
    .select("id, total, tip_amount, professional_id, created_at, finance_sale_lines(item_name, item_type, line_total, professional_id), finance_sale_payments(amount, method)")
    .eq("organization_id", activeOrg.orgId)
    .gte("created_at", `${dateFrom}T00:00:00`)
    .lte("created_at", `${dateTo}T23:59:59.999`)
    .neq("state", "cancelled");

  const sales = salesData ?? [];

  const revenueByMethod: Record<string, number> = {};
  const revenueByService: Record<string, { count: number; total: number }> = {};
  const revenueByDay: Record<string, number> = {};

  for (const s of sales) {
    const salePayments = (s as Record<string, unknown>).finance_sale_payments;
    if (Array.isArray(salePayments)) {
      for (const p of salePayments) {
        const method = (p as Record<string, unknown>).method as string ?? "other";
        const amount = (p as Record<string, unknown>).amount as number ?? 0;
        revenueByMethod[method] = (revenueByMethod[method] ?? 0) + amount;
      }
    }

    const saleLines = (s as Record<string, unknown>).finance_sale_lines;
    if (Array.isArray(saleLines)) {
      for (const item of saleLines) {
        const name = (item as Record<string, unknown>).item_name as string ?? "Sin nombre";
        const total = (item as Record<string, unknown>).line_total as number ?? 0;
        if (!revenueByService[name]) revenueByService[name] = { count: 0, total: 0 };
        revenueByService[name].count++;
        revenueByService[name].total += total;
      }
    }

    const day = typeof s.created_at === "string" ? s.created_at.split("T")[0]! : "unknown";
    revenueByDay[day] = (revenueByDay[day] ?? 0) + (s.total ?? 0);
  }

  const totalRevenue = sales.reduce((sum, s) => sum + (s.total ?? 0), 0);

  const { data: expensesData } = await supabase
    .from("finance_expenses")
    .select("amount, category")
    .eq("organization_id", activeOrg.orgId)
    .gte("expense_date", dateFrom)
    .lte("expense_date", dateTo);

  const expenses = expensesData ?? [];
  const totalExpenses = expenses.reduce((sum, e) => sum + (e.amount ?? 0), 0);
  const expensesByCategory: Record<string, number> = {};
  for (const e of expenses) {
    expensesByCategory[e.category] = (expensesByCategory[e.category] ?? 0) + (e.amount ?? 0);
  }

  const result = {
    period: { start: dateFrom, end: dateTo },
    revenue: {
      total: totalRevenue,
      by_method: revenueByMethod,
      by_service: Object.entries(revenueByService)
        .map(([name, v]) => ({ name, ...v }))
        .sort((a, b) => b.total - a.total),
      by_day: Object.entries(revenueByDay)
        .map(([date, total]) => ({ date, total }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    },
    expenses: { total: totalExpenses, by_category: expensesByCategory },
    profit: totalRevenue - totalExpenses,
    sales_count: sales.length,
    avg_ticket: sales.length > 0 ? Math.round((totalRevenue / sales.length) * 100) / 100 : 0,
  };

  return ok(result, { requestId });
}
