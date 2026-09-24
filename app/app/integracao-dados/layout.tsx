import { notFound } from "next/navigation";

import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * O banco externo é módulo opcional da instalação, desligado por padrão (doc 37).
 * Desligado, estas telas não existem — para ninguém, nem para o admin da
 * empresa: quem liga é quem administra o servidor, em `/admin/sistema`. O
 * layout cobre a lista e a tela da conexão de uma vez.
 */
export default async function Layout({ children }: { children: React.ReactNode }) {
  if (!(await moduloLigado(createAdminClient(), "banco_externo"))) notFound();
  return children;
}
