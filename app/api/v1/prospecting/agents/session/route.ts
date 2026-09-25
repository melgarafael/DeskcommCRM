import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ok, fail } from "@/lib/api/wrappers";
import { AgentSetupError } from "@/lib/prospecting/agent-setup";
import { agentSessionPatchSchema } from "@/lib/prospecting/agent-session-schema";
import { getAgentSession, saveAgentSession } from "@/lib/prospecting/agent-session";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
function failure(error: unknown, requestId: string) {
  return fail(
    "prospecting_agent_session_failed",
    error instanceof AgentSetupError
      ? error.message
      : "Não foi possível salvar ou recuperar a conversa. Tente novamente.",
    error instanceof AgentSetupError ? error.status : 500,
    { requestId, headers },
  );
}

export async function GET(req: Request) {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "prospecting" });
  if (!auth.ok) return auth.response;
  const campaign = z.string().uuid().safeParse(new URL(req.url).searchParams.get("campaign_id"));
  if (!campaign.success)
    return fail("validation_failed", "Escolha uma campanha válida.", 422, { requestId, headers });
  try {
    return ok(await getAgentSession(getRequestPool(), auth.org.orgId, campaign.data), {
      requestId,
      headers,
    });
  } catch (error) {
    return failure(error, requestId);
  }
}

export async function PATCH(req: Request) {
  const support = await requireSupportWrite();
  if (support) return support;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "prospecting" });
  if (!auth.ok) return auth.response;
  const parsed = agentSessionPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("validation_failed", "Confira a conversa e a configuração antes de salvar.", 422, {
      requestId,
      headers,
    });
  try {
    return ok(
      await saveAgentSession(
        getRequestPool(),
        { orgId: auth.org.orgId, userId: auth.user.id, requestId },
        parsed.data.campaign_id,
        parsed.data.revision,
        parsed.data.session,
      ),
      { requestId, headers },
    );
  } catch (error) {
    return failure(error, requestId);
  }
}
