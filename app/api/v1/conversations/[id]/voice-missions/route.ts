import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { MissionError, missionInput } from "@/lib/voice/missions/schema";
import { readMissions, saveMission } from "@/lib/voice/missions/store";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
async function handle(request: Request, context: Context, write: boolean) {
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "voice_calls" });
  if (!auth.ok) return auth.response;
  const id = z
    .string()
    .uuid()
    .safeParse((await context.params).id);
  if (!id.success) return fail("invalid_request", "Atendimento inválido.", 400, { requestId });
  try {
    if (!write)
      return ok(await readMissions(getRequestPool(), auth.org.orgId, id.data, auth.user.id), {
        requestId,
        headers: { "Cache-Control": "no-store" },
      });
    const input = missionInput.safeParse(await request.json().catch(() => null));
    if (!input.success)
      return fail("invalid_request", "Confira o objetivo e as escolhas da ligação.", 422, {
        requestId,
      });
    const rate = await checkRateLimit(`voice-mission:${auth.org.orgId}:${auth.user.id}`, 20, 60);
    if (!rate.allowed)
      return fail("rate_limited", "Aguarde um minuto antes de tentar novamente.", 429, {
        requestId,
      });
    const result = await saveMission(
      getRequestPool(),
      auth.org.orgId,
      auth.user.id,
      id.data,
      input.data,
    );
    void audit({
      action: "voice.mission_requested",
      organizationId: auth.org.orgId,
      actorUserId: auth.user.id,
      resourceType: "voice_mission",
      resourceId: result.id,
      requestId,
      metadata: { operation: input.data.action, conversation_id: id.data },
    });
    return ok(result, { requestId });
  } catch (e) {
    return fail(
      "voice_assistant_unavailable",
      e instanceof MissionError
        ? e.message
        : "Não foi possível salvar o pedido. Suas escolhas continuam na tela.",
      e instanceof MissionError ? e.status : 503,
      { requestId },
    );
  }
}
export function GET(r: Request, c: Context) {
  return handle(r, c, false);
}
export async function POST(r: Request, c: Context) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  return handle(r, c, true);
}
