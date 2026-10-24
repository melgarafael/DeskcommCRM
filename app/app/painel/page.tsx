import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { PainelDoSetor } from "./_components/PainelDoSetor";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Painel do setor" };

export default async function PainelPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  return <PainelDoSetor />;
}
