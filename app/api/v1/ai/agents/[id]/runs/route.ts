/**
 * GET /api/v1/ai/agents/:id/runs (manager+)
 *
 * Cursor pagination opaco base64 (started_at + id) — same convention as outras rotas.
 * Filtro opcional ?status=...
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { runsListQuerySchema } from "@/lib/ai/agents/validation";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RUN_COLUMNS =
  "id, organization_id, agent_id, agent_version_id, conversation_id, contact_id, channel_session_id, inbound_message_id, outbound_message_id, status, abort_reason, error_code, error_message, tokens_in, tokens_out, cost_cents, latency_ms, steps_count, tool_calls, is_dry_run, started_at, completed_at, created_at";

type Ctx = { params: Promise<{ id: string }> };

interface CursorPayload {
  started_at: string;
  id: string;
}

function encodeCursor(p: CursorPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}

function decodeCursor(raw: string): CursorPayload | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const p = JSON.parse(json) as CursorPayload;
    if (typeof p.id !== "string" || typeof p.started_at !== "string") return null;
    return p;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("manager", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const sp = req.nextUrl.searchParams;
  const parsed = runsListQuerySchema.safeParse({
    cursor: sp.get("cursor") ?? undefined,
    limit: sp.get("limit") ?? undefined,
    status: sp.get("status") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", "Query inválida.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const q = parsed.data;

  const supabase = await createClient();
  let query = supabase
    .from("ai_agent_runs")
    .select(RUN_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .eq("agent_id", id)
    .order("started_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(q.limit + 1);

  if (q.status) query = query.eq("status", q.status);

  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (!c) return fail("invalid_request", "cursor inválido.", 400, { requestId });
    // Tuple-aware seek: started_at < c.started_at OR (=, id < c.id).
    query = query.or(
      `started_at.lt.${c.started_at},and(started_at.eq.${c.started_at},id.lt.${c.id})`,
    );
  }

  const { data, error } = await query;
  if (error) return fail("internal_error", "Erro ao listar runs.", 500, { requestId });

  const rows = data ?? [];
  const hasMore = rows.length > q.limit;
  const slice = hasMore ? rows.slice(0, q.limit) : rows;
  const last = slice[slice.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ started_at: last.started_at as string, id: last.id as string })
      : null;

  return ok(slice, {
    requestId,
    meta: { cursor: nextCursor, has_more: hasMore },
  });
}
