import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// POST /api/v1/finance/journal-entries/[id]/post — post a draft entry
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const { id } = await params;

  const supabase = await createClient();

  // Verify the entry exists and is in draft state
  const { data: entry, error: fetchError } = await supabase
    .from("finance_journal_entries")
    .select("id, state")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .single();

  if (fetchError) {
    if (fetchError.code === "PGRST116") return fail("not_found", "Journal entry not found", 404, { requestId });
    return fail("internal_error", fetchError.message, 500, { requestId });
  }

  if (entry.state !== "draft") {
    return fail("invalid_state", "Only draft entries can be posted", 422, { requestId });
  }

  const { data, error } = await supabase
    .from("finance_journal_entries")
    .update({ state: "posted" })
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select()
    .single();

  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data, { requestId });
}
