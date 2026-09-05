import { NavHub } from "@/components/shell/NavHub";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/**
 * Hub da Análise.
 *
 * Terceira vez que a mesma promessa é paga: o comentário de densidade do
 * `Sidebar.tsx` diz que grupo SEM hub que passa de quatro telas ganha um hub —
 * não mais alguns pixels de padding raspados. Atividades (PR #583) foi a quinta
 * tela do grupo e a dobra de 1280×900 estourou em 13px (`scrollHeight` 776
 * contra 763 de altura visível, com o "Audit Log" 13px abaixo da caixa da
 * `<nav>`). Nenhum valor de `Sidebar.tsx` mudou por causa disto.
 *
 * O sidebar fica com o que se pergunta toda semana (Desempenho, Meta Ads,
 * Atividades); o que se visita de propósito (Evolução da IA, Audit Log) fica
 * aqui. As duas seções são essa régua escrita por extenso — e, como nos outros
 * hubs, esta tela é INVENTÁRIO: lista as cinco, inclusive as que continuam no
 * menu.
 *
 * Passa `locale` (o padrão do `NavHub` é pt-BR): quem escolheu espanhol lê o
 * título, o subtítulo e as seções em espanhol, e não uma tela meio traduzida.
 */
export default async function AnaliseHubPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  const idioma = user.idioma;

  return (
    <NavHub
      group="analise"
      isPlatformAdmin={user.is_platform_admin}
      role={activeOrg?.role ?? null}
      title={traduzir("Análise", idioma)}
      subtitle={traduzir("Como o negócio foi no período — e o histórico para quando alguém perguntar por quê.", idioma)}
      locale={idioma}
    />
  );
}
