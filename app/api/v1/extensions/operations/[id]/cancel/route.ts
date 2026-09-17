import { ok } from "@/lib/api/wrappers";
import { extensionFailure, extensionId, requireExtensionPlatform } from "@/lib/extensions/http";
import { cancelExtensionInstall } from "@/lib/extensions/service";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const denied = await requireSupportWrite();
    if (denied) return denied;
    const authz = await requireExtensionPlatform();
    if (!authz.ok) return authz.response;
    return ok(await cancelExtensionInstall(authz.user.id, extensionId((await context.params).id)));
  } catch (error) {
    return extensionFailure(error);
  }
}
