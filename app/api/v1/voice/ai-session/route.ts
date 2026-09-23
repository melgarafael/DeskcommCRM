import { randomUUID } from "node:crypto";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";

/**
 * Compatibility response for the short-lived browser bridge. AI calls now use
 * durable voice missions, including context, cancellation and quota accounting.
 * Never issue an unmetered ephemeral token through the superseded route.
 */
export async function POST(): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "voice_calls" });
  if (!auth.ok) return auth.response;
  return fail(
    "voice_mission_required",
    "Atualize a página e use Pedir ligação à IA na conversa. O pedido será acompanhado até o resultado.",
    410,
    { requestId },
  );
}
