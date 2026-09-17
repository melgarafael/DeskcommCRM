import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { extensionFailure, requireExtensionOrganization } from "@/lib/extensions/http";
import { listExtensions } from "@/lib/extensions/service";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const authz = await requireRole("viewer", { resource: "extension_installations" });
    if (!authz.ok) return authz.response;
    requireExtensionOrganization(request, authz.org.orgId);
    return ok(await listExtensions(authz.user, authz.org), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return extensionFailure(error);
  }
}
