import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  ExtensionServiceError,
  extensionFailure,
  extensionId,
  requireExtensionOrganization,
} from "@/lib/extensions/http";
import { extensionRequestJson, openRequestSchema } from "@/lib/extensions/requests";
import { loadExtensionGuide } from "@/lib/extensions/service";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const denied = await requireSupportWrite();
    if (denied) return denied;
    const authz = await requireRole("viewer", { resource: "organization_extensions" });
    if (!authz.ok) return authz.response;
    requireExtensionOrganization(request, authz.org.orgId);
    const input = openRequestSchema.parse(await extensionRequestJson(request));
    const guide = await loadExtensionGuide(authz.org.orgId, extensionId((await context.params).id));
    if (guide.revision !== input.expected_revision) {
      throw new ExtensionServiceError(
        "extension_revision_conflict",
        "A configuração mudou em outra sessão. Recarregue antes de continuar.",
      );
    }
    // O card tem de existir na versão VIGENTE. Uma aba aberta antes de uma troca de versão
    // pediria uma ação que a versão instalada talvez não tenha mais.
    const card = guide.manifest.contributions.crm_cards.find((item) => item.id === input.card_id);
    if (card?.action.capability !== input.capability) {
      throw new ExtensionServiceError(
        "extension_card_unavailable",
        "Este card não existe na versão instalada. Recarregamos o guia.",
      );
    }
    // Esta capacidade só resolve um destino do núcleo. Nenhum dado de tarefa
    // vai ao pacote; a rota de Tarefas continua exigindo sua autorização própria.
    return ok({ href: "/app/tasks" });
  } catch (error) {
    return extensionFailure(error);
  }
}
