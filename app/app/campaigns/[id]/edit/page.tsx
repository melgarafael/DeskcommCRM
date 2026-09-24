import type { Metadata } from "next";

import { EditarCampanha } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Editar campanha" };

export default async function EditarCampanhaPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <EditarCampanha id={id} />;
}
