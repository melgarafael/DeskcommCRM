import {recordLegacyNotice,legacyRecoveryCause,legacyRecoveryMessage} from '@/lib/ai/agents/legacy-notice';
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { publishFirstVersion } from "@/lib/ai/agents/first-publication";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
const input = z.object({
  channel_id: z.uuid(),
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(200),
  credential_id: z.uuid().nullable(),
});
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID(),
    auth = await requireRole("admin", { requestId, resource: "ai_agents" });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params,
    parsed = input.safeParse(await req.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !parsed.success)
    return fail("validation_failed", "Escolha canal, modelo e credencial.", 422, { requestId });
  const admin = createAdminClient();
  const { data: agent } = await admin
    .from("ai_agents")
    .select("id,kind,system_prompt,published_version_id,archived_at")
    .eq("organization_id", auth.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!agent || agent.kind === "mcp_agent" || agent.archived_at)
    return fail("not_found", "Agente legado indisponível.", 404, { requestId });
  if (agent.published_version_id) {
    await recordLegacyNotice(admin,auth.org.orgId,id,'pronto');
    return ok({ published: true }, { requestId });
  }
  const { data: versions, error } = await admin
    .from("ai_agent_versions")
    .select("id,provisioning_origin")
    .eq("organization_id", auth.org.orgId)
    .eq("agent_id", id)
    .limit(2);
  if (error)
    return fail("internal_error", "Não foi possível conferir as versões.", 500, { requestId });
  if (
    versions?.length &&
    !(versions.length === 1 && versions[0]?.provisioning_origin === "legacy_reconciliation")
  )
    return fail(
      "existing_version_requires_review",
      "Já existe uma versão. Revise e publique essa versão no editor.",
      409,
      { requestId },
    );
  const p = parsed.data,
    result = await publishFirstVersion(
      admin,
      auth.org.orgId,
      agent,
      agent.system_prompt ?? "",
      auth.user.id,
      {
        channelId: p.channel_id,
        provider: p.provider,
        model: p.model,
        credentialId: p.credential_id,
      },
    );
  const cause=legacyRecoveryCause(result);
  await recordLegacyNotice(admin,auth.org.orgId,id,cause);
  void audit({
    action: "ai_agent.reconciled",
    actorUserId: auth.user.id,
    organizationId: auth.org.orgId,
    resourceType: "ai_agent",
    resourceId: id,
    requestId,
    metadata: { published: result.published },
  });
  if (!result.published)
    return fail(
      cause,
      legacyRecoveryMessage(cause),
      422,
      { requestId },
    );
  return ok(result, { requestId });
}
