import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { MysteryShopperClient } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cliente Oculto | Saraiva CRM" };

export default async function MysteryShopperPage() {
  const user = await loadAuthUser();
  if (!user) redirect("/login");
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/login");

  return <MysteryShopperClient orgId={activeOrg.orgId} />;
}
