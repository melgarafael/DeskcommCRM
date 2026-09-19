import { randomUUID } from "node:crypto";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { AgentSetupError, setupProspectingAgent } from "@/lib/prospecting/agent-setup";
import { prospectingAgentSetupSchema } from "@/lib/prospecting/agent-setup-schema";

export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const support = await requireSupportWrite();
  if (support) return support;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "ai_agents" });
  if (!auth.ok) return auth.response;
  const input = prospectingAgentSetupSchema.safeParse(await req.json().catch(() => null));
  if (!input.success)
    return fail(
      "validation_failed",
      "Confira o nome, a oferta, os critérios de qualificação, a conexão e o funil.",
      422,
      { requestId },
    );
  try {
    return ok(
      await setupProspectingAgent(
        getRequestPool(),
        createAdminClient(),
        { orgId: auth.org.orgId, userId: auth.user.id, requestId },
        input.data,
      ),
      { requestId, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return fail(
      "prospecting_agent_setup_failed",
      error instanceof AgentSetupError
        ? error.message
        : "Não foi possível preparar o agente. Tente novamente.",
      error instanceof AgentSetupError ? error.status : 500,
      {
        requestId,
        details:
          error instanceof AgentSetupError && error.agentId
            ? { agent_id: error.agentId }
            : undefined,
      },
    );
  }
}
