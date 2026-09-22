import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { redirect } from "next/navigation";
import { WelcomeForm } from "./_form";
import { branding } from "@/lib/branding";
import { createClient } from "@/lib/supabase/server";
import { lerRetratoDaInstalacao } from "@/lib/instalacao/retrato";
import { JaEstaPronto } from "../_components/JaEstaPronto";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export default async function WelcomePage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/login");
  const idioma = user.idioma;

  const supabase = await createClient();
  const retrato = await lerRetratoDaInstalacao({ supabase, orgId: activeOrg.orgId });

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-medium text-text tracking-tight">
          {traduzir("Boas-vindas ao", idioma)} {branding().name}
        </h2>
        <p className="text-sm text-muted-foreground">
          {traduzir("Vamos montar quem vai atender seus clientes — e onde ele vai trabalhar.", idioma)}
        </p>
      </header>

      <JaEstaPronto retrato={retrato} idioma={idioma} />

      {/*
        O instalador NUNCA pergunta o nome do negócio: toda organização nasce
        "Minha Empresa", hardcoded. Mandar esse texto como valor inicial fazia a
        pessoa ter de apagá-lo antes de escrever o nome dela — e quem não
        percebia seguia com o placeholder no cabeçalho do sistema para sempre.
      */}
      <WelcomeForm defaultOrgName={retrato.empresa.aindaSemNomeProprio ? "" : activeOrg.name} />
    </div>
  );
}
