import { type NextRequest } from "next/server";
import { z } from "zod";
import { falhaDaEscritaDePlatformAdmin, requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const querySchema = z.object({
  q: z.string().optional(),
  status: z.enum(["pending", "open", "resolved"]).optional(),
  tenant_id: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

// ---------------------------------------------------------------------------
// Cursor helpers (base64, opaque)
// ---------------------------------------------------------------------------

interface CursorPayload {
  last_inbound_at: string | null;
  id: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as CursorPayload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/inbox/conversations
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const requestId = randomUUID();

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const parsed = querySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams.entries()),
  );
  if (!parsed.success) {
    return fail("validation_error", "Invalid query params", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { q, status, tenant_id, cursor, limit } = parsed.data;

  const admin = createAdminClient();

  // Decode cursor for keyset pagination
  const cursorPayload = cursor ? decodeCursor(cursor) : null;

  // Build query — cross-tenant intentional, service-role bypasses RLS
  let query = admin
    .from("conversations")
    .select(
      `
      id,
      organization_id,
      contact_id,
      channel,
      status,
      last_inbound_at,
      last_message_at,
      last_message_preview,
      unread_count_for_assignee,
      created_at,
      organizations!inner ( display_name, slug ),
      contacts ( name, phone_number )
    `,
    )
    .order("last_inbound_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    .limit(limit + 1); // fetch one extra to determine has_more

  if (status) {
    query = query.eq("status", status);
  }

  if (tenant_id) {
    query = query.eq("organization_id", tenant_id);
  }

  if (q) {
    // search by last_message_preview or contact phone (best-effort, no FTS needed)
    query = query.ilike("last_message_preview", `%${q}%`);
  }

  if (cursorPayload) {
    // Keyset: rows where (last_inbound_at, id) < cursor
    if (cursorPayload.last_inbound_at) {
      query = query.or(
        `last_inbound_at.lt.${cursorPayload.last_inbound_at},and(last_inbound_at.eq.${cursorPayload.last_inbound_at},id.lt.${cursorPayload.id})`,
      );
    } else {
      // null last_inbound_at rows come last — always include if cursor has null
      query = query.is("last_inbound_at", null);
    }
  }

  const { data, error } = await query;

  if (error) {
    return fail("internal_error", "Query failed", 500, { requestId, details: error.message });
  }

  const rows = data ?? [];
  const has_more = rows.length > limit;
  const page = has_more ? rows.slice(0, limit) : rows;

  const lastRow = page.at(-1);
  const nextCursor = has_more && lastRow
    ? encodeCursor({
        last_inbound_at: (lastRow as { last_inbound_at?: string | null }).last_inbound_at ?? null,
        id: lastRow.id,
      })
    : null;

  // Audit (lightweight — no PII in metadata)
  void audit({
    action: "platform_admin.inbox_listed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    requestId,
    metadata: {
      filters: { status: status ?? null, tenant_id: tenant_id ?? null, has_q: !!q },
      result_count: page.length,
    },
  });

  return ok(page, {
    requestId,
    meta: { has_more, cursor: nextCursor },
  });
}
