import { notFound, redirect } from "next/navigation";

import { CabecalhoDaSubTela } from "@/components/settings/CabecalhoDaSubTela";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { cadenciasHabilitadas } from "@/lib/cadencias/modulo";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { Configuracao } from "./Configuracao";

export const dynamic = "force-dynamic";
export default async function Page() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  if (ROLE_RANK[org.role] < ROLE_RANK.admin) redirect("/403");
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "cadencias"))) notFound();
  const { data, error } = await admin.from("organizations").select("settings").eq("id", org.orgId).single();
  if (error) throw new Error("cadencia_settings_read_failed");
  return (
    <>
      <div className="mx-auto w-full max-w-3xl px-6 pt-6">
        <CabecalhoDaSubTela idioma={user.idioma} />
      </div>
      <Configuracao enabled={cadenciasHabilitadas(data.settings)} />
    </>
  );
}
