/**
 * POST /api/v1/conversations/[id]/usable-for-rag
 *
 * Agent-toggle for the RAG opt-in flag (LGPD L-08). When enabled, the
 * conversation becomes eligible for the daily kb-conversations-batch cron,
 * which anonymizes + chunks + embeds the dialogue into the agent's KB.
 *
 * Auth: cookie session, role >= agent.
 * Audit: action `conversation.usable_for_rag_toggled` with prev/next values.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { validateRequest } from "@/lib/schemas/_validate";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ enabled: z.boolean() });

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let input;
  try {
    input = await validateRequest(bodySchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const supabase = await createClient();

  // Read prev value first to put it in the audit payload (best-effort).
  const { data: prevRow } = await supabase
    .from("conversations")
    .select("usable_for_rag")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  const prev = (prevRow as { usable_for_rag: boolean } | null)?.usable_for_rag ?? null;

  const nowIso = new Date().toISOString();
  const update = input.enabled
    ? {
        usable_for_rag: true,
        usable_for_rag_marked_at: nowIso,
        usable_for_rag_marked_by: authUser.id,
        rag_review_status: null,
      }
    : {
        usable_for_rag: false,
        usable_for_rag_marked_at: null,
        usable_for_rag_marked_by: null,
        rag_review_status: null,
      };

  const { data, error } = await supabase
    .from("conversations")
    .update(update)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select("id, usable_for_rag")
    .maybeSingle();

  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }
  if (!data) {
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  }

  await audit({
    action: "conversation.usable_for_rag_toggled",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "conversation",
    resourceId: id,
    metadata: { conversation_id: id, enabled: input.enabled, prev },
    requestId,
  });

  return ok(data, { requestId });
}
