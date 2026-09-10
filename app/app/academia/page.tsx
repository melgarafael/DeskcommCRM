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
  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
    <header><h1 className="text-2xl font-semibold">{traduzir("Minha Academia", user.idioma)}</h1>
      <p className="mt-2 text-muted-foreground">{org.name}</p></header>
    <section className="rounded-xl border bg-card p-6">
      <h2 className="font-semibold">{traduzir("Módulo ativo", user.idioma)}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{traduzir("Esta empresa tem acesso à área da academia. A ativação pode ser alterada por um administrador, sem apagar os dados.", user.idioma)}</p>
      {org.role === "admin" && <Link className="mt-5 inline-block text-sm underline underline-offset-4" href="/app/settings/modules">{traduzir("Gerenciar módulos", user.idioma)}</Link>}
    </section>
  </div>;
}
