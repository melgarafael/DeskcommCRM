import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ProspectingClient } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Prospecção" };
export default async function ProspectingPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (org?.role !== "admin") redirect("/app/inbox");
  return <ProspectingClient />;
}
