import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { mfaEmDivida } from "@/lib/auth/server";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { voiceActionSchema, VoiceAssistantError } from "@/lib/ai/voice/schema";
import { performVoiceAction, readVoicePanel } from "@/lib/ai/voice/store";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
const headers = { "Cache-Control": "no-store" };
type Context = { params: Promise<{ id: string }> };
function failure(error: unknown, requestId: string) {
  return fail(
    "voice_assistant_unavailable",
    error instanceof VoiceAssistantError
      ? error.message
      : "Não foi possível concluir a configuração de voz. Atualize a página e tente novamente.",
    error instanceof VoiceAssistantError ? error.status : 502,
    { requestId, headers },
  );
}
export async function GET(_request: Request, context: Context) {
  const requestId = randomUUID();
  const id = z
    .string()
    .uuid()
    .safeParse((await context.params).id);
  if (!id.success) return fail("invalid_request", "Agente inválido.", 400, { requestId, headers });
  const auth = await requireRole("admin", { requestId, resource: "ai_agents" });
  if (!auth.ok) return auth.response;
  try {
    return ok(await readVoicePanel(getRequestPool(), auth.org.orgId, id.data), {
      requestId,
      headers,
    });
  } catch (error) {
    return failure(error, requestId);
  }
}
export async function POST(request: Request, context: Context) {
  const requestId = randomUUID();
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const id = z
    .string()
    .uuid()
    .safeParse((await context.params).id);
  const parsed = voiceActionSchema.safeParse(await request.json().catch(() => null));
  if (!id.success || !parsed.success)
    return fail("validation_failed", "Confira os campos do assistente de voz.", 422, {
      requestId,
      headers,
    });
  const agentId = id.data;
  const auth = await requireRole("admin", { requestId, resource: "ai_agents" });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, {
      requestId,
      headers,
    });
  const limit = await checkRateLimit(`voice-assistant:${auth.org.orgId}`, 12, 60);
  if (!limit.allowed)
    return fail("rate_limited", "Aguarde um minuto antes de continuar.", 429, {
      requestId,
      headers: { ...headers, "Retry-After": "60" },
    });
  try {
    const result = await performVoiceAction(
      getRequestPool(),
      auth.org.orgId,
      auth.user.id,
      agentId,
      parsed.data,
    );
    void audit({
      action: parsed.data.action === "test" ? "ai_agent.tested" : "ai_agent.updated",
      organizationId: auth.org.orgId,
      actorUserId: auth.user.id,
      resourceType: "ai_agent",
      resourceId: agentId,
      requestId,
      metadata: { module: "voice_assistant", operation: parsed.data.action },
    });
    return ok(result, { requestId, headers });
  } catch (error) {
    return failure(error, requestId);
  }
}
