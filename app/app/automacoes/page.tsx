import type { Metadata } from "next";
import { NavHub } from "@/components/shell/NavHub";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { modulosLigados } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Automações" };

/**
 * Hub de Automações — a casa única de tudo que age sozinho: os Fluxos (o
 * construtor visual), as Regras QUANDO/SE/ENTÃO e os ajustes. Mesmo molde do
 * hub de IA (`app/app/ai/page.tsx`): uma projeção do catálogo de navegação.
 */
export default async function AutomacoesHubPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  const idioma = user.idioma;

  return (
    <NavHub
      group="automacoes"
      isPlatformAdmin={user.is_platform_admin && !user.support}
      role={activeOrg?.role ?? null}
      interfaceSettings={activeOrg?.interface_settings}
      modulosLigados={await modulosLigados(createAdminClient())}
      title={traduzir("Automações", idioma)}
      subtitle={traduzir(
        "Fluxos e regras que atendem, distribuem e movem o cliente sem ninguém precisar clicar.",
        idioma,
      )}
      locale={idioma}
    />
  );
}
