import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { fail, ok } from "@/lib/api/wrappers";
import { PILOT_ASSISTANT_ID } from "@/lib/assistant-pilot/types";
import { executeInternalTurn } from "@/lib/assistant-pilot/internal-service";
import { getInternalSession } from "@/lib/assistant-pilot/internal-store";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { pilotEnabled } from "@/lib/assistant-pilot/gate";
export const runtime = "nodejs";
const bodySchema = z
  .object({
    channel: z.literal("crm"),
    text: z.string().trim().min(1).max(4000),
    turn_id: z.string().uuid(),
  })
  .strict();
async function auth(requestId: string) {
  const r = await requireRole("agent", { requestId });
  if (!r.ok) return r;
  const identity = { userId: r.user.id, tenantId: r.org.orgId, assistantId: PILOT_ASSISTANT_ID };
  if (r.user.support || !pilotEnabled(identity))
    return {
      ok: false as const,
      response: fail("not_found", "Assistente não disponível.", 404, { requestId }),
    };
  return { ok: true as const, identity };
}
export async function GET() {
  const requestId = randomUUID(),
    a = await auth(requestId);
  if (!a.ok) return a.response;
  try {
    return ok(await getInternalSession(getRequestPool(), a.identity), { requestId });
  } catch {
    return fail("internal_error", "Histórico interno indisponível.", 503, { requestId });
  }
}
export async function POST(request: Request) {
  const requestId = randomUUID(),
    p = bodySchema.safeParse(await request.json().catch(() => null));
  if (!p.success)
    return fail("invalid_request", "Turno inválido. Este piloto só conversa e consulta.", 422, {
      requestId,
    });
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const a = await auth(requestId);
  if (!a.ok) return a.response;
  try {
    return ok(
      await executeInternalTurn(
        a.identity,
        p.data.turn_id,
        p.data.text,
        AbortSignal.timeout(90000),
      ),
      { requestId },
    );
  } catch {
    return fail(
      "internal_error",
      "Turno não confirmado. Consulte o histórico; não repita automaticamente. Verifique configuração em Agente de IA › Provedores.",
      503,
      { requestId },
    );
  }
}
