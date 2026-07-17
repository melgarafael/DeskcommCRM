/**
 * GET /api/v1/audit/export — CSV export of audit entries (up to 10k rows).
 *
 * Same filters as /api/v1/audit. No pagination — single shot. Use sparingly.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { auditQuerySchema } from "@/lib/schemas/audit";

export const dynamic = "force-dynamic";

const HEADER = [
  "id",
  "created_at",
  "actor_user_id",
  "action",
  "resource_type",
  "resource_id",
  "request_id",
  "actor_ip",
  "metadata",
];

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", {
    requestId,
    resource: "audit",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  // Force a high limit for export, ignore caller's `limit`.
  const parsed = auditQuerySchema.safeParse({ ...params, limit: undefined });
  if (!parsed.success) {
    return fail("validation_failed", "Query inválida.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const q = parsed.data;

  const supabase = await createClient();
  let query = supabase
    .from("api_audit_log")
    .select(
      "id, created_at, actor_user_id, action, resource_type, resource_id, request_id, actor_ip, metadata",
    )
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false })
    .limit(10_000);

  if (q.actor_id) query = query.eq("actor_user_id", q.actor_id);
  if (q.action) query = query.ilike("action", `%${q.action}%`);
  if (q.resource_type) query = query.eq("resource_type", q.resource_type);
  if (q.from) query = query.gte("created_at", q.from);
  if (q.to) query = query.lte("created_at", q.to);

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const rows = data ?? [];
  const lines = [HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.created_at,
        r.actor_user_id,
        r.action,
        r.resource_type,
        r.resource_id,
        r.request_id,
        r.actor_ip,
        r.metadata,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  const csv = lines.join("\n") + "\n";
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`,
      "X-Request-Id": requestId,
    },
  });
}
