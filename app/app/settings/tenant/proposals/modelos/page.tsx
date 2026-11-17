import { redirect } from "next/navigation";

import { CabecalhoDaSubTela } from "@/components/settings/CabecalhoDaSubTela";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ModelosDeProposta } from "./_client";

export const metadata = { title: "Modelos de proposta" };

export default async function ModelosDePropostaPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  return (
    <>
      <div className="mx-auto w-full max-w-3xl px-6 pt-6">
        <CabecalhoDaSubTela idioma={user.idioma} />
      </div>
      <ModelosDeProposta />
    </>
  );
}
