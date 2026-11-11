import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "contabilidad" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();

  const { data: cashData, error: cashErr } = await supabase
    .from("finance_v_cash_position")
    .select("*")
    .eq("organization_id", activeOrg.orgId);

  if (cashErr) return fail("internal", cashErr.message, 500, { requestId });

  const { data: ledgerData, error: ledgerErr } = await supabase
    .from("finance_v_ledger")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .in("code", (cashData ?? []).map((c: { code: string }) => c.code))
    .order("entry_date", { ascending: true });

  if (ledgerErr) return fail("internal", ledgerErr.message, 500, { requestId });

  const entries = (ledgerData ?? []) as { debit: number; credit: number; line_description: string | null; entry_number: string }[];

  const categorize = (desc: string | null) => {
    const d = (desc || "").toLowerCase();
    if (d.includes("inversion") || d.includes("equipo") || d.includes("activo")) return "investing";
    if (d.includes("prestamo") || d.includes("capital") || d.includes("dividendo")) return "financing";
    return "operating";
  };

  const sections: Record<string, { inflows: number; outflows: number }> = {
    operating: { inflows: 0, outflows: 0 },
    investing: { inflows: 0, outflows: 0 },
    financing: { inflows: 0, outflows: 0 },
  };

  for (const e of entries) {
    const cat = categorize(e.line_description || e.entry_number);
    const sec = sections[cat];
    if (sec) {
      sec.inflows += e.debit;
      sec.outflows += e.credit;
    }
  }

  const cashAccounts = (cashData ?? []) as { code: string; name: string; balance: number }[];
  const totalCash = cashAccounts.reduce((s, a) => s + a.balance, 0);
  const netChange = Object.values(sections).reduce((s, sec) => s + sec.inflows - sec.outflows, 0);

  return ok({
    sections: Object.entries(sections).map(([key, val]) => ({
      category: key,
      inflows: val.inflows,
      outflows: val.outflows,
      net: val.inflows - val.outflows,
    })),
    net_change: netChange,
    closing_balance: totalCash,
    cash_accounts: cashAccounts,
  }, { requestId });
}
