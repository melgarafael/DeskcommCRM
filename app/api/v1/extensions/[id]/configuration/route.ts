import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  ExtensionServiceError,
  extensionFailure,
  extensionId,
  operationKey,
  requireExtensionOrganization,
} from "@/lib/extensions/http";
import { configureRequestSchema, extensionRequestJson } from "@/lib/extensions/requests";
import { configureExtension } from "@/lib/extensions/service";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const denied = await requireSupportWrite();
    if (denied) return denied;
    const authz = await requireRole("admin", { resource: "organization_extensions" });
    if (!authz.ok) return authz.response;
    requireExtensionOrganization(request, authz.org.orgId);
    if (authz.user.support) {
      throw new ExtensionServiceError(
        "forbidden",
        "Saia do acompanhamento para configurar extensões.",
        403,
      );
    }
    const id = extensionId((await context.params).id);
    const key = operationKey(request);
    const input = configureRequestSchema.parse(await extensionRequestJson(request));
    return ok(await configureExtension(authz.user.id, authz.org.orgId, id, key, input));
  } catch (error) {
    return extensionFailure(error);
  }
}
