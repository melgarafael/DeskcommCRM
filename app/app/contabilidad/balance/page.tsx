import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";

import { BalanceSheetClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function BalancePage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  return <BalanceSheetClient />;
}
