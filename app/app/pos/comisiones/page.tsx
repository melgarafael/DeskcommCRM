import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ComisionesPOSClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function ComisionesPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  return <ComisionesPOSClient />;
}
