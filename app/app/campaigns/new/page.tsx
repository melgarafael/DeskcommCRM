import type { Metadata } from "next";

import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

import { NovaCampanha } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Nova campanha" };

export default async function NovaCampanhaPage() {
  // Doc 305 (A): a opção "E-mail" segue o módulo `campanha_por_email`, desligado de fábrica.
  return <NovaCampanha emailLigado={await moduloLigado(createAdminClient(), "campanha_por_email")} />;
}
