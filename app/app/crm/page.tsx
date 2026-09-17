import type { Metadata } from "next";
import { NavHub } from "@/components/shell/NavHub";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { loadCrmExtensions } from "@/lib/extensions/service";
import { logger } from "@/lib/logger";
import type { ExtensionGuideView } from "@/lib/extensions/view";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "CRM" };

/**
 * Hub do CRM.
 *
 * Nasceu de uma promessa escrita: o comentário de densidade do `Sidebar.tsx`
 * dizia que, quando o quinto destino de CRM aparecesse, o conserto seria criar
 * o hub do grupo — e não raspar mais alguns pixels de padding. Tarefas (PR
 * #546) foi o quinto, e a dobra de 900px estourou em 13px.
 *
 * O sidebar fica com o que se abre todo dia (Funis, Contatos, Tarefas); o que
 * se define uma vez (Produtos, Etapas do funil) fica aqui. As duas seções são a
 * mesma régua escrita por extenso: o hub não é a sobra do menu, é o inventário
 * do grupo — Funis, Contatos e Tarefas aparecem aqui também.
 *
 * Passa `locale` (o padrão do `NavHub` é pt-BR): quem escolheu espanhol lê o
 * título, o subtítulo e as seções em espanhol, e não uma tela meio traduzida.
 */
export default async function CrmHubPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  const idioma = user.idioma;
  let extensionGuides: ExtensionGuideView[] = [];
  let extensionsUnavailable = false;

  if (activeOrg) {
    try {
      extensionGuides = await loadCrmExtensions(activeOrg.orgId);
    } catch (error) {
      // O hub continua útil sem extensões, mas a falha precisa ser distinguível
      // de uma lista legitimamente vazia. A gestão oferece a reconciliação — e o
      // log diz que o hub degradou, para a falha não existir só na tela.
      const code = (error as { code?: unknown } | null)?.code;
      logger.warn("[crm] hub aberto sem as orientações das extensões", {
        organization_id: activeOrg.orgId,
        error_code: typeof code === "string" ? code : null,
      });
      extensionsUnavailable = true;
    }
  }

  return (
    <NavHub
      group="crm"
      isPlatformAdmin={user.is_platform_admin && !user.support}
      role={activeOrg?.role ?? null}
      interfaceSettings={activeOrg?.interface_settings}
      title={traduzir("CRM", idioma)}
      subtitle={traduzir(
        "Onde a venda acontece — e o que você define uma vez para ela funcionar.",
        idioma,
      )}
      locale={idioma}
      extensionGuides={extensionGuides}
      extensionsUnavailable={extensionsUnavailable}
    />
  );
}
