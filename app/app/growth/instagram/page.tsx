import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { InstagramGrowthClient } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Instagram Growth | Saraiva CRM" };

export default async function InstagramGrowthPage() {
  const user = await loadAuthUser();
  if (!user) redirect("/login");
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/login");

  return <InstagramGrowthClient orgId={activeOrg.orgId} />;
}
