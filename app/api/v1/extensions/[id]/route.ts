import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { extensionFailure, extensionId, requireExtensionOrganization } from "@/lib/extensions/http";
import { loadExtensionGuide } from "@/lib/extensions/service";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const authz = await requireRole("viewer", { resource: "organization_extensions" });
    if (!authz.ok) return authz.response;
    requireExtensionOrganization(request, authz.org.orgId);
    const id = extensionId((await context.params).id);
    return ok(await loadExtensionGuide(authz.org.orgId, id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return extensionFailure(error);
  }
}
