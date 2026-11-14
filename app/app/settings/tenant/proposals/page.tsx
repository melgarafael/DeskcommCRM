import { redirect } from "next/navigation";

import { CabecalhoDaSubTela } from "@/components/settings/CabecalhoDaSubTela";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ProposalsSettingsClient } from "./_client";

export default async function ProposalsSettingsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  return (
    <>
      <div className="mx-auto w-full max-w-2xl px-6 pt-6">
        <CabecalhoDaSubTela idioma={user.idioma} />
      </div>
      <ProposalsSettingsClient />
    </>
  );
}
