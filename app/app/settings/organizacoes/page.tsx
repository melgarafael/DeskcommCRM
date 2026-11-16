import { notFound, redirect } from "next/navigation";
import { CabecalhoDaSubTela } from "@/components/settings/CabecalhoDaSubTela";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { ClientesDaAgencia } from "./_client";
export default async function OrganizacoesDaAgenciaPage() {
  // Doc 321: módulo desligado, a tela não existe — a mesma resposta das rotas.
  if (!(await moduloLigado(createAdminClient(), "agencias"))) notFound();
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org || user.support || !(user.agency_org_ids ?? []).includes(org.orgId))
    redirect("/app/settings");
  return (
    <>
      <div className="px-6 pt-6">
        <CabecalhoDaSubTela idioma={user.idioma} />
      </div>
      <ClientesDaAgencia />
    </>
  );
}
