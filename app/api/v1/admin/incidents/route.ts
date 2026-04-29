/**
 * GET /api/v1/admin/incidents (S-11.11)
 *
 * Lists incidents cross-tenant. Requires platform admin.
 * Filters: status (default 'open'), severity, tenant_id.
 * Cursor-based pagination by (created_at desc, id).
 */
import { type NextRequest } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const querySchema = z.object({
  status: z.enum(["open", "acknowledged", "resolved"]).default("open"),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  tenant_id: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
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
// GET /api/v1/admin/incidents
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const requestId = randomUUID();

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
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

  const { status, severity, tenant_id, cursor, limit } = parsed.data;
  const admin = createAdminClient();
  const cursorPayload = cursor ? decodeCursor(cursor) : null;

  let query = admin
    .from("incidents")
    .select(
      `id, organization_id, type, severity, payload, status,
       acknowledged_at, acknowledged_by, resolved_at, resolved_by,
       resolution_note, created_at, updated_at,
       organizations!incidents_organization_id_fkey(display_name, slug)`,
    )
    .eq("status", status)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (severity) query = query.eq("severity", severity);
  if (tenant_id) query = query.eq("organization_id", tenant_id);

  if (cursorPayload) {
    query = query.or(
      `created_at.lt.${cursorPayload.created_at},and(created_at.eq.${cursorPayload.created_at},id.lt.${cursorPayload.id})`,
    );
  }

  const { data, error } = await query;

  if (error) {
    return fail("internal_error", "Failed to fetch incidents", 500, { requestId });
  }

  const rows = data ?? [];
  const has_more = rows.length > limit;
  const page = has_more ? rows.slice(0, limit) : rows;

  const nextCursor =
    has_more && page.length > 0
      ? encodeCursor({
          created_at: page[page.length - 1]!.created_at,
          id: page[page.length - 1]!.id,
        })
      : null;

  const shaped = page.map((row) => {
    const org = Array.isArray(row.organizations)
      ? row.organizations[0]
      : row.organizations;
    return {
      ...row,
      organizations: undefined,
      tenant_name: org?.display_name ?? null,
      tenant_slug: org?.slug ?? null,
    };
  });

  void audit({
    action: "platform_admin.incidents_listed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    requestId,
    bypassedRls: true,
    metadata: { status, severity, tenant_id, count: shaped.length },
  });

  return ok(
    { data: shaped, meta: { has_more, cursor: nextCursor } },
    { requestId },
  );
}
