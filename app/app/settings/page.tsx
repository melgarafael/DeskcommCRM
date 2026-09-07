import { NavHub } from "@/components/shell/NavHub";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/**
 * Hub de Organização.
 *
 * A lista de cards que vivia aqui era uma segunda navegação escrita à mão, e
 * divergia do sidebar — Funis, Conexões e Audit Log apareciam como se fossem
 * configuração, quando são CRM, Canais e Análise. Agora o conteúdo vem do
 * registro, e o que sobra aqui é o que de fato é organização: sua conta, sua
 * empresa, e quem tem acesso ao quê.
 *
 * O card-ponte para "Canal oficial (Meta) e templates" que a `main` manteve
 * aqui NÃO foi perdido no merge — ele foi promovido. A ponte existia porque
 * conectar canal tinha duas respostas dependendo do WhatsApp, e quem já sabia
 * procurar em Configurações precisava continuar achando. Com o registro, o
 * grupo CANAIS fica visível no sidebar para todo admin e o ⌘K acha "canal
 * oficial" por nome — a pergunta passa a ter um lugar só, que é o que a ponte
 * tentava ensinar apontando para outro.
 */
export default async function SettingsHubPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  const idioma = user.idioma;

  return (
    <NavHub
      group="organizacao"
      isPlatformAdmin={user.is_platform_admin && !user.support}
      role={activeOrg?.role ?? null}
      interfaceSettings={activeOrg?.interface_settings}
      title={traduzir("Configurações", idioma)}
      subtitle={traduzir("Sua conta, os dados da empresa e quem tem acesso ao quê.", idioma)}
      locale={idioma}
    />
  );
}
