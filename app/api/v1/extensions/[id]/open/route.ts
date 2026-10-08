import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { destinoDaCapacidade } from "@/lib/extensions/capacidades";
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
    // `?? []`: um pacote de DADOS não contribui card nenhum (ADR-0005), então a lista pode faltar.
    // Sem card, nada casa com o id pedido e o caminho cai na recusa logo abaixo — que é o certo:
    // pedir para abrir um card num módulo que não tem cards é pedido inválido, não erro de tipo.
    const card = (guide.manifest.contributions.crm_cards ?? []).find((item) => item.id === input.card_id);
    if (card?.action.capability !== input.capability) {
      throw new ExtensionServiceError(
        "extension_card_unavailable",
        "Este card não existe na versão instalada. Recarregamos o guia.",
      );
    }
    // O destino vem do MAPA, nunca de literal. Este ponto ficou com `/app/tasks` fixo depois
    // que a ADR-0003 abriu seis portas: o schema recusava as novas, e quando parou de recusar,
    // todas as seis abriam Tarefas. Medido em tela: o clique em `inbox.open` navegava para
    // `/app/tasks`. Nenhum dado do pacote entra aqui — ele nomeia a capacidade, o host traduz,
    // e a tela de destino continua exigindo a autorização própria dela.
    const href = destinoDaCapacidade(input.capability);
    if (!href) {
      throw new ExtensionServiceError(
        "extension_card_unavailable",
        "Este card não existe na versão instalada. Recarregamos o guia.",
      );
    }
    return ok({ href });
  } catch (error) {
    return extensionFailure(error);
  }
}
