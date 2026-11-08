import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { PainelDeAtendimento } from "./_components/PainelDeAtendimento";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Painel de atendimento" };

export default async function PainelPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  return <PainelDeAtendimento />;
}
