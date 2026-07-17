/**
 * POST /api/v1/conversations/[id]/reactivate-bot
 *
 * Devolve o controle da conversa ao bot — clears `bot_silenced_until` que foi
 * setado pelo handoff orchestrator (`'infinity'` por design IA-06).
 *
 * Auth: cookie session, role >= agent.
 * Audit: action `ai.reactivated_by_agent`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  const supabase = await createClient();

  // RLS will already restrict to the active org, but we filter explicitly
  // because clarity > implicit.
  const { data, error } = await supabase
    .from("conversations")
    .update({ bot_silenced_until: null })
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select("id, organization_id, bot_silenced_until")
    .maybeSingle();

  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }
  if (!data) {
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  }

  await audit({
    action: "ai.reactivated_by_agent",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "conversation",
    resourceId: id,
    requestId,
  });

  return ok({ reactivated: true }, { requestId });
}
