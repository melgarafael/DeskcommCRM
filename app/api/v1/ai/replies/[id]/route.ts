import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
const input = z.object({
  action: z.enum(["approve", "reject"]),
  revision: z.string().regex(/^\d+$/),
  body: z.string().trim().min(1).max(12000).optional(),
  feedback: z.string().max(1000).optional(),
});
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID(),
    auth = await requireRole("agent", { requestId, resource: "conversations" });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params,
    parsed = input.safeParse(await req.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !parsed.success)
    return fail("validation_failed", "Campos inválidos.", 422, { requestId });
  const db = await createClient(),
    p = parsed.data;
  const { data, error } = await db.rpc("fn_reply_action", {
    p_org: auth.org.orgId,
    p_id: id,
    p_revision: p.revision,
    p_action: p.action,
    p_body: p.body ?? null,
    p_feedback: p.feedback ?? null,
  });
  if (error) {
    const conflict = error.message.includes("stale") || error.message.includes("conflict");
    return fail(
      conflict ? "reply_context_stale" : "reply_not_authorized",
      conflict
        ? "A conversa mudou. Sua edição foi preservada; gere e revise uma nova sugestão."
        : "Não foi possível autorizar esta resposta.",
      conflict ? 409 : 403,
      { requestId },
    );
  }
  void audit({
    action: p.action === "approve" ? "ai_reply.approved" : "ai_reply.rejected",
    actorUserId: auth.user.id,
    organizationId: auth.org.orgId,
    resourceType: "ai_reply_draft",
    resourceId: id,
    requestId,
  });
  return ok(
    { job_id: data, status: p.action === "approve" ? "approved" : "dismissed" },
    { requestId },
  );
}
