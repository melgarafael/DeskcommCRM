import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ClientesDaAgencia } from "./_client";
export default async function OrganizacoesDaAgenciaPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org || user.support || !(user.agency_org_ids ?? []).includes(org.orgId))
    redirect("/app/settings");
  return <ClientesDaAgencia />;
}
