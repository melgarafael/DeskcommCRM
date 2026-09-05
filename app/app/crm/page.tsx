import { NavHub } from "@/components/shell/NavHub";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

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

  return (
    <NavHub
      group="crm"
      isPlatformAdmin={user.is_platform_admin}
      role={activeOrg?.role ?? null}
      title={traduzir("CRM", idioma)}
      subtitle={traduzir("Onde a venda acontece — e o que você define uma vez para ela funcionar.", idioma)}
      locale={idioma}
    />
  );
}
