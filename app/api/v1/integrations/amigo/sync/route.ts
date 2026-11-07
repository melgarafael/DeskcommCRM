import { randomUUID } from "node:crypto";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { syncAmigo } from "@/lib/amigo/sync";
import { audit } from "@/lib/audit";
import { ok } from "@/lib/api/wrappers";
import { amigoFailure } from "../_shared";
export async function POST() {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const auth = await requireRole("manager", { requestId });
  if (!auth.ok) return auth.response;
  try {
    const result = await syncAmigo(auth.org.orgId, requestId);
    if (result.examined > 0 || result.reconciled > 0)
      await audit({
        action: "amigo.synced",
        organizationId: auth.org.orgId,
        actorUserId: auth.user.id,
        requestId,
        metadata: { examined: result.examined, reconciled: result.reconciled },
      });
    return ok(result, { requestId });
  } catch (error) {
    return amigoFailure(error, requestId);
  }
}
