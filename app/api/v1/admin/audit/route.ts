import { type NextRequest } from "next/server";
import { z } from "zod";
import { falhaDaEscritaDePlatformAdmin, requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const querySchema = z.object({
  tenant_ids: z.string().optional(), // csv of uuids
  actor_user_id: z.string().uuid().optional(),
  actions: z.string().optional(), // csv of action codes
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

interface CursorPayload {
  created_at: string;
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
// GET /api/v1/admin/audit
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

  const { tenant_ids, actor_user_id, actions, from, to, cursor, limit } = parsed.data;
  const admin = createAdminClient();
  const cursorPayload = cursor ? decodeCursor(cursor) : null;

  // Parse csv filters
  const tenantIdsArr = tenant_ids
    ? tenant_ids.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const actionsArr = actions
    ? actions.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  let query = admin
    .from("api_audit_log")
    .select(
      `
      id,
      organization_id,
      action,
      actor_user_id,
      resource_type,
      resource_id,
      metadata,
      request_id,
      created_at,
      acting_as_platform_admin,
      bypassed_rls,
      organizations!api_audit_log_organization_id_fkey (
        display_name,
        slug
      )
      `,
    )
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (tenantIdsArr && tenantIdsArr.length > 0) {
    query = query.in("organization_id", tenantIdsArr);
  }

  if (actor_user_id) {
    query = query.eq("actor_user_id", actor_user_id);
  }

  if (actionsArr && actionsArr.length > 0) {
    query = query.in("action", actionsArr);
  }

  if (from) {
    query = query.gte("created_at", from);
  }

  if (to) {
    query = query.lte("created_at", to);
  }

  if (cursorPayload) {
    query = query.or(
      `created_at.lt.${cursorPayload.created_at},and(created_at.eq.${cursorPayload.created_at},id.lt.${cursorPayload.id})`,
    );
  }

  const { data, error } = await query;

  if (error) {
    return fail("internal_error", "Query failed", 500, {
      requestId,
      details: error.message,
    });
  }

  const rows = data ?? [];
  const has_more = rows.length > limit;
  const page = has_more ? rows.slice(0, limit) : rows;

  const lastRow = page.at(-1);
  const nextCursor =
    has_more && lastRow
      ? encodeCursor({
          created_at: (lastRow as { created_at: string }).created_at,
          id: lastRow.id,
        })
      : null;

  // Lightweight audit — fire and forget
  void audit({
    action: "platform_admin.audit_listed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    requestId,
    metadata: {
      filters: {
        has_tenant_ids: !!tenantIdsArr,
        has_actor: !!actor_user_id,
        has_actions: !!actionsArr,
        has_from: !!from,
        has_to: !!to,
      },
      result_count: page.length,
    },
  });

  return ok(page, {
    requestId,
    meta: { has_more, cursor: nextCursor },
  });
}
