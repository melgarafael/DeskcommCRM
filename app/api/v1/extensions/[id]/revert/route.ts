import { ok } from "@/lib/api/wrappers";
import {
  extensionFailure,
  extensionId,
  operationKey,
  requireExtensionPlatform,
} from "@/lib/extensions/http";
import { extensionRequestJson, installationChangeRequestSchema } from "@/lib/extensions/requests";
import { revertExtension } from "@/lib/extensions/service";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";

/** Desfazer a última troca de versão, em todas as organizações. Não baixa nada. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const denied = await requireSupportWrite();
    if (denied) return denied;
    const authz = await requireExtensionPlatform();
    if (!authz.ok) return authz.response;
    const key = operationKey(request);
    const input = installationChangeRequestSchema.parse(await extensionRequestJson(request));
    const id = extensionId((await context.params).id);
    return ok(await revertExtension(authz.user.id, key, id, input));
  } catch (error) {
    return extensionFailure(error);
  }
}
