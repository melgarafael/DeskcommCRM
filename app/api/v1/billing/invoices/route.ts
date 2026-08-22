/**
 * GET /api/v1/billing/invoices — histórico de faturas do tenant ativo, paginado.
 *
 * Admin-only, mesmo motivo de /api/v1/billing/subscription. Cursor opaco
 * base64 por (created_at, id), mesmo padrão de /api/v1/admin/tenants.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { ok, fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";

const querySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

interface CursorPayload {
  created_at: string;
  id: string;
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as CursorPayload;
  } catch {
    return null;
  }
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "billing" });
  if (!authz.ok) return authz.response;

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parsed.success) {
    return fail("validation_failed", "Invalid query params", 400, { requestId });
  }
  const { cursor, limit } = parsed.data;
  const cursorPayload = cursor ? decodeCursor(cursor) : null;

  const admin = createAdminClient();
  let query = admin
    .from("billing_invoices")
    .select("id, status, amount_cents, currency, due_date, paid_at, invoice_url, created_at")
    .eq("organization_id", authz.org.orgId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (cursorPayload) {
    query = query.or(
      `created_at.lt.${cursorPayload.created_at},and(created_at.eq.${cursorPayload.created_at},id.lt.${cursorPayload.id})`,
    );
  }

  const { data, error } = await query;
  if (error) {
    return fail("internal_error", "Failed to load invoices", 500, { requestId });
  }

  const rows = data ?? [];
  const has_more = rows.length > limit;
  const page = has_more ? rows.slice(0, limit) : rows;
  const lastRow = page.at(-1);
  const nextCursor =
    has_more && lastRow ? encodeCursor({ created_at: lastRow.created_at, id: lastRow.id }) : null;

  return ok(page, { requestId, meta: { has_more, cursor: nextCursor } });
}
