import type { Metadata } from "next";
import { NavHub } from "@/components/shell/NavHub";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { modulosLigados } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Agente de IA" };

/**
 * Hub da área de IA.
 *
 * Substitui as abas que só apareciam para quem JÁ estava dentro de `/app/ai/*`:
 * Conhecimento, Credenciais, Uso, Casos e Alertas eram invisíveis de qualquer
 * outro lugar do sistema. Aqui as dez telas aparecem juntas, na jornada de quem
 * opera um agente — montar, ensinar, acompanhar.
 *
 * Passa `locale` (o padrão do `NavHub` é pt-BR): sem isso o hub inteiro ficava
 * em português mesmo com idioma=es — títulos, seções e descrições.
 */
export default async function AiHubPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  const idioma = user.idioma;

  return (
    <NavHub
      group="ia"
      isPlatformAdmin={user.is_platform_admin && !user.support}
      role={activeOrg?.role ?? null}
      interfaceSettings={activeOrg?.interface_settings}
      modulosLigados={await modulosLigados(createAdminClient())}
      title={traduzir("Agente de IA", idioma)}
      subtitle={traduzir(
        "Tudo que define quem atende por você — e como acompanhar o que ele faz.",
        idioma,
      )}
      locale={idioma}
    />
  );
}
