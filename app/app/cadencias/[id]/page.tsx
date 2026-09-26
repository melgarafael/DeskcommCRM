import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { Construtor } from "./_components/Construtor";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cadência" };

export default async function CadenciaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  // Montar cadência é decisão de quem gere a prospecção, como os follow-ups.
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");

  return <Construtor id={id} />;
}
