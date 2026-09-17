import { ok } from "@/lib/api/wrappers";
import {
  extensionFailure,
  operationKey,
  readExtensionBody,
  requireExtensionPlatform,
} from "@/lib/extensions/http";
import { admitExtensionCatalog } from "@/lib/extensions/service";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const denied = await requireSupportWrite();
    if (denied) return denied;
    const authz = await requireExtensionPlatform();
    if (!authz.ok) return authz.response;
    const key = operationKey(request);
    const bytes = await readExtensionBody(request, 512 * 1024);
    return ok(await admitExtensionCatalog(authz.user.id, key, bytes));
  } catch (error) {
    return extensionFailure(error);
  }
}
