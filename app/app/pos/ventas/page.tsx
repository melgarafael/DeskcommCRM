import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { VentasPOSClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function VentasPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  return <VentasPOSClient />;
}
