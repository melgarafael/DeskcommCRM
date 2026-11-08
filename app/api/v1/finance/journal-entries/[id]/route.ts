import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// GET /api/v1/finance/journal-entries/[id] — single entry with lines
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const { id } = await params;

  const supabase = await createClient();
  const { data: entry, error } = await supabase
    .from("finance_journal_entries")
    .select("*")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .single();

  if (error) {
    if (error.code === "PGRST116") return fail("not_found", "Journal entry not found", 404, { requestId });
    return fail("internal_error", error.message, 500, { requestId });
  }

  const { data: lines, error: linesError } = await supabase
    .from("finance_journal_entry_lines")
    .select("id, entry_id, account_id, name, debit, credit")
    .eq("entry_id", id)
    .eq("organization_id", activeOrg.orgId)
    .order("id");

  if (linesError) return fail("internal_error", linesError.message, 500, { requestId });

  return ok({ ...entry, lines: lines ?? [] }, { requestId });
}
