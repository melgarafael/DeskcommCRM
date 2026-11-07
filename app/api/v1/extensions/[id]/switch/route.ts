import { ok } from "@/lib/api/wrappers";
import {
  extensionFailure,
  extensionId,
  operationKey,
  requireExtensionPlatform,
} from "@/lib/extensions/http";
import { extensionRequestJson, switchRequestSchema } from "@/lib/extensions/requests";
import { switchExtension } from "@/lib/extensions/service";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";

/**
 * O interruptor, por instalação, do módulo `connected` (spec 33, D8): liga ou desliga sem desinstalar.
 * Só sessão de quem administra a instalação, como remover: não entra em `lib/auth/public-paths.ts` e
 * nenhum token alcança esta rota.
 */
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
    const input = switchRequestSchema.parse(await extensionRequestJson(request));
    const id = extensionId((await context.params).id);
    return ok(await switchExtension(authz.user.id, key, id, input));
  } catch (error) {
    return extensionFailure(error);
  }
}
