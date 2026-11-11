import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { consentRequestSchema, definirConsentimento } from "@/lib/extensions/consentimento";
import {
  ExtensionServiceError,
  extensionFailure,
  extensionId,
  requireExtensionOrganization,
} from "@/lib/extensions/http";
import { extensionRequestJson } from "@/lib/extensions/requests";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";

/**
 * Grava as áreas do CRM que a organização consente a um módulo `connected` (spec 33, F3, tarefa 5).
 * Só SESSÃO de quem administra a organização (a regra de `configuration`): não entra em
 * `lib/auth/public-paths.ts`, e nenhum token alcança esta rota. A organização vem da sessão, nunca
 * do corpo; o corpo leva só a revisão esperada e a lista fechada de áreas.
 */
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
    const input = consentRequestSchema.parse(await extensionRequestJson(request));
    return ok(await definirConsentimento(authz.user.id, authz.org.orgId, id, input));
  } catch (error) {
    return extensionFailure(error);
  }
}
