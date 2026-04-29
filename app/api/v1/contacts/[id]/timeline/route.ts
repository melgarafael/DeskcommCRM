/**
 * GET /api/v1/contacts/[id]/timeline
 *
 * Returns polymorphic timeline (`crm_lead_activities`) for a contact, merging
 * direct `contact_id` activities with activities attached to leads owned by
 * this contact. Two RLS-scoped queries client-side (supabase-js does not
 * compose `.or` with subqueries cleanly), then merge → sort → cursor-paginate.
 *
 * Filters:
 *   - type: repeatable query param (?type=order_created&type=message_inbound)
 *   - cursor: opaque base64 of (performed_at, id)
 *   - limit: 1..100 (default 50)
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";
import type { TimelineItem } from "@/lib/types/contacts";

export const dynamic = "force-dynamic";

const TIMELINE_COLS =
  "id, organization_id, lead_id, contact_id, source_module, source_id, type, payload, metadata, performed_at, performed_by_user_id";

interface Cursor {
  performed_at: string;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
function decodeCursor(raw: string): Cursor | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Cursor;
    if (typeof parsed.id !== "string" || typeof parsed.performed_at !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: contactId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const url = new URL(req.url);
  const types = url.searchParams.getAll("type").filter(Boolean);
  const cursorRaw = url.searchParams.get("cursor");
  const limitRaw = url.searchParams.get("limit");
  const limit = Math.min(Math.max(parseInt(limitRaw ?? "50", 10) || 50, 1), 100);

  let cursor: Cursor | null = null;
  if (cursorRaw) {
    cursor = decodeCursor(cursorRaw);
    if (!cursor) {
      return fail("invalid_cursor", "Cursor inválido.", 400, { requestId });
    }
  }

  // Verify contact accessible (RLS will filter); 404 if not.
  const { data: contactRow, error: cErr } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .maybeSingle();
  if (cErr) return fail("internal_error", cErr.message, 500, { requestId });
  if (!contactRow) return fail("not_found", "Contato não encontrado.", 404, { requestId });

  // Resolve owned lead ids first.
  const { data: leadRows, error: lErr } = await supabase
    .from("crm_leads")
    .select("id")
    .eq("contact_id", contactId);
  if (lErr) return fail("internal_error", lErr.message, 500, { requestId });

  const leadIds = (leadRows ?? []).map((r) => (r as { id: string }).id);

  // Pull last (limit + 1) from each side to detect has_more after merge.
  // We over-fetch slightly to keep merge correct.
  const FETCH = limit + 1;

  const buildQuery = (column: "contact_id" | "lead_id", values: string | string[]) => {
    let q = supabase
      .from("crm_lead_activities")
      .select(TIMELINE_COLS)
      .order("performed_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(FETCH);
    if (Array.isArray(values)) q = q.in(column, values);
    else q = q.eq(column, values);
    if (types.length > 0) q = q.in("type", types);
    if (cursor) {
      q = q.or(
        `performed_at.lt.${cursor.performed_at},and(performed_at.eq.${cursor.performed_at},id.lt.${cursor.id})`,
      );
    }
    return q;
  };

  const directQ = buildQuery("contact_id", contactId);
  const leadQ =
    leadIds.length > 0 ? buildQuery("lead_id", leadIds) : Promise.resolve({ data: [], error: null });

  const [directRes, leadRes] = await Promise.all([directQ, leadQ]);

  if (directRes.error) {
    return fail("internal_error", directRes.error.message, 500, { requestId });
  }
  if ("error" in leadRes && leadRes.error) {
    return fail("internal_error", leadRes.error.message, 500, { requestId });
  }

  const merged = new Map<string, TimelineItem>();
  for (const row of (directRes.data ?? []) as TimelineItem[]) merged.set(row.id, row);
  for (const row of ((leadRes.data ?? []) as TimelineItem[]) ?? []) merged.set(row.id, row);

  const sorted = Array.from(merged.values()).sort((a, b) => {
    if (a.performed_at !== b.performed_at) {
      return a.performed_at < b.performed_at ? 1 : -1;
    }
    return a.id < b.id ? 1 : -1;
  });

  const hasMore = sorted.length > limit;
  const page = hasMore ? sorted.slice(0, limit) : sorted;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ performed_at: last.performed_at, id: last.id })
      : null;

  return ok(page, {
    requestId,
    meta: { cursor: nextCursor, has_more: hasMore },
  });
}
