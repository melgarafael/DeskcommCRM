import type { Metadata } from "next";

import { NovaCampanha } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Nova campanha" };

export default function NovaCampanhaPage() {
  return <NovaCampanha />;
}
