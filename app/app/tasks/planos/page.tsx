import type { Metadata } from "next";

import { PlanosDeTarefa } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Planos de tarefa" };

export default function PaginaDePlanosDeTarefa() {
  return <PlanosDeTarefa />;
}
