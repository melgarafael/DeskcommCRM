import { AcademiaWorkspace } from "./_workspace";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { carregarModulos } from "@/lib/modules/server";
import { traduzir } from "@/lib/i18n/dicionario";
export const dynamic = "force-dynamic";
export default async function AcademiaPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  if (!(await carregarModulos(org.orgId)).academia) notFound();
  return <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
    <header><h1 className="text-2xl font-semibold">{traduzir("Minha Academia", user.idioma)}</h1>
      <p className="mt-2 text-muted-foreground">{org.name}</p></header>
    <p className="text-muted-foreground">{traduzir("Organize a grade de aulas e os cadastros da sua academia.", user.idioma)}</p>
    {org.role === "admin" && <Link className="text-sm underline underline-offset-4" href="/app/settings/modules">{traduzir("Gerenciar módulos", user.idioma)}</Link>}
    <AcademiaWorkspace key={org.orgId} canEdit={org.role === "admin" || org.role === "manager"} />
  </div>;
}
