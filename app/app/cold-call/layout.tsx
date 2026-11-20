import { notFound } from "next/navigation";

import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * O Cold Call é módulo opcional da instalação, desligado por padrão (#3933).
 * Desligado, a tela não existe para ninguém: quem liga é quem administra o
 * servidor, em `/admin/sistema`.
 */
export default async function Layout({ children }: { children: React.ReactNode }) {
  if (!(await moduloLigado(createAdminClient(), "cold_call"))) notFound();
  return children;
}
