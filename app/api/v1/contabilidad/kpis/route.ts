import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "contabilidad" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
  const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;

  const { data: cashPosition } = await supabase
    .from("finance_v_cash_position")
    .select("*")
    .eq("organization_id", activeOrg.orgId);

  const cashAccounts = (cashPosition ?? []) as { code: string; name: string; balance: number }[];
  const cashBalance = cashAccounts.reduce((s, a) => s + a.balance, 0);

  const { data: pnlCurrent } = await supabase
    .from("finance_v_monthly_pnl")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .eq("year", currentYear)
    .eq("month", currentMonth)
    .limit(1);

  const { data: pnlPrev } = await supabase
    .from("finance_v_monthly_pnl")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .eq("year", prevYear)
    .eq("month", prevMonth)
    .limit(1);

  const current = (pnlCurrent?.[0] as { revenue: number; expenses: number; net_income: number } | undefined) ?? { revenue: 0, expenses: 0, net_income: 0 };
  const prev = (pnlPrev?.[0] as { revenue: number; expenses: number; net_income: number } | undefined) ?? null;

  const revenue = current.revenue;
  const expenses = current.expenses;
  const netIncome = current.net_income;

  let netIncomeTrend = 0;
  if (prev && Math.abs(prev.net_income) > 0)
    netIncomeTrend = ((netIncome - prev.net_income) / Math.abs(prev.net_income)) * 100;

  let revenueTrend = 0;
  if (prev && Math.abs(prev.revenue) > 0)
    revenueTrend = ((revenue - prev.revenue) / Math.abs(prev.revenue)) * 100;

  const grossMargin = revenue !== 0 ? ((revenue - expenses) / revenue) * 100 : 0;

  const { data: accountSummary } = await supabase
    .from("finance_v_account_summary")
    .select("*")
    .eq("organization_id", activeOrg.orgId);

  const { count: draftCount } = await supabase
    .from("finance_journal_entries")
    .select("*", { count: "exact", head: true })
    .eq("organization_id", activeOrg.orgId)
    .eq("state", "draft");

  const { count: postedCount } = await supabase
    .from("finance_journal_entries")
    .select("*", { count: "exact", head: true })
    .eq("organization_id", activeOrg.orgId)
    .eq("state", "posted");

  const { count: cancelledCount } = await supabase
    .from("finance_journal_entries")
    .select("*", { count: "exact", head: true })
    .eq("organization_id", activeOrg.orgId)
    .eq("state", "cancelled");

  const { data: pnlHistory } = await supabase
    .from("finance_v_monthly_pnl")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("year", { ascending: false })
    .order("month", { ascending: false })
    .limit(6);

  const history = ((pnlHistory ?? []) as { year: number; month: number; period_name: string; revenue: number; expenses: number; net_income: number }[]).reverse();

  const recentMonths = history.slice(-3);
  const burnRate = recentMonths.length > 0
    ? recentMonths.reduce((s, m) => s + Math.abs(m.expenses), 0) / recentMonths.length
    : 0;
  const runwayMonths = burnRate > 0 ? cashBalance / burnRate : 999;

  const { data: arData } = await supabase
    .from("finance_accounts_receivable")
    .select("balance")
    .eq("organization_id", activeOrg.orgId)
    .in("status", ["pending", "partial"]);

  const totalAR = (arData ?? []).reduce((s: number, r: { balance: number }) => s + (r.balance || 0), 0);
  const dso = revenue > 0 ? (totalAR / revenue) * 30 : null;
  const dsoRisk: string | null = dso === null ? null : dso <= 30 ? "low" : dso <= 60 ? "medium" : dso <= 90 ? "high" : "critical";

  const { data: budgetData } = await supabase
    .from("finance_monthly_budgets")
    .select("budgeted_amount")
    .eq("organization_id", activeOrg.orgId)
    .eq("year", currentYear)
    .eq("month", currentMonth)
    .eq("category", "total_expenses")
    .limit(1);

  const budgetedExpenses: number | null = (budgetData?.[0] as { budgeted_amount: number } | undefined)?.budgeted_amount ?? null;
  const actualExpensesAbs = Math.abs(expenses);
  const budgetVariance = budgetedExpenses !== null ? actualExpensesAbs - budgetedExpenses : null;
  const budgetVariancePct = budgetedExpenses !== null && budgetedExpenses > 0 ? (budgetVariance! / budgetedExpenses) * 100 : null;
  const budgetRisk: string | null = budgetVariancePct === null ? null : Math.abs(budgetVariancePct) <= 5 ? "low" : Math.abs(budgetVariancePct) <= 15 ? "medium" : Math.abs(budgetVariancePct) <= 30 ? "high" : "critical";

  return ok({
    cashBalance,
    cashAccounts,
    revenue,
    expenses,
    netIncome,
    netIncomeTrend,
    revenueTrend,
    grossMargin,
    burnRate,
    runwayMonths,
    entriesByStatus: { draft: draftCount || 0, posted: postedCount || 0, cancelled: cancelledCount || 0 },
    accountSummary: accountSummary ?? [],
    pnlHistory: history,
    totalAccountsReceivable: totalAR,
    dso,
    dsoRisk,
    budgetedExpenses,
    budgetVariance,
    budgetVariancePct,
    budgetRisk,
  }, { requestId });
}
