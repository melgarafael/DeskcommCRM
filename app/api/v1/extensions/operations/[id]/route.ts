import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  extensionFailure,
  extensionId,
  requireExtensionOrganization,
} from "@/lib/extensions/http";
import { canManageInstallation, readExtensionOperation } from "@/lib/extensions/service";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const authz = await requireRole("viewer", { resource: "extension_operations" });
    if (!authz.ok) return authz.response;
    requireExtensionOrganization(request, authz.org.orgId);
    const id = extensionId((await context.params).id);
    const platform = await canManageInstallation(authz.user);
    return ok(await readExtensionOperation(id, authz.org.orgId, platform), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return extensionFailure(error);
  }
}
