import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { POSDashboardClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function POSPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  return <POSDashboardClient />;
}
