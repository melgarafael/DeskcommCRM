import { notFound } from "next/navigation";

import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Os roteiros de atendimento são MÓDULO OPCIONAL da instalação (doc 64),
 * desligado por padrão: sem a chave ligada em `/admin/sistema`, esta área não
 * existe — 404, a mesma resposta das rotas e do banco externo desligado.
 */
export default async function RoteirosLayout({ children }: { children: React.ReactNode }) {
  if (!(await moduloLigado(createAdminClient(), "fluxos_atendimento"))) notFound();
  return children;
}
