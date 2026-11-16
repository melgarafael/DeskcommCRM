import { notFound } from "next/navigation";

import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * O Painel de atendimento é MÓDULO OPCIONAL da instalação, desligado por padrão:
 * sem a chave ligada em `/admin/sistema`, esta área não existe (404).
 */
export default async function PainelLayout({ children }: { children: React.ReactNode }) {
  if (!(await moduloLigado(createAdminClient(), "painel_atendimento"))) notFound();
  return children;
}
