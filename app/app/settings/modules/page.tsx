import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { carregarModulos } from "@/lib/modules/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { ModulesForm } from "./_form";
export const dynamic = "force-dynamic";
export default async function ModulesPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  if (org.role !== "admin") redirect("/403");
  const modules = await carregarModulos(org.orgId);
  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
    <header><h1 className="text-2xl font-semibold">{traduzir("Módulos da empresa", user.idioma)}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{traduzir("Ative os recursos que fazem sentido para o seu negócio.", user.idioma)}</p></header>
    <ModulesForm key={`${org.orgId}:${modules.academia}`} initial={modules.academia} organizationName={org.name} />
  </div>;
}
