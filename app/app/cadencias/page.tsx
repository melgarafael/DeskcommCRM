import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { ListaDeCadencias } from "./_components/ListaDeCadencias";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cadências" };

export default async function CadenciasPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");

  return <ListaDeCadencias />;
}
