import type { Metadata } from "next";

import { DetalheDaCampanha } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Campanha" };

export default async function CampanhaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DetalheDaCampanha id={id} />;
}
