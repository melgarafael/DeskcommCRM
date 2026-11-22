import { notFound } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Empresas, pessoas e importação são módulo opcional da instalação, desligado
 * por padrão (doc 68). Desligado, estas telas não existem para ninguém: quem
 * liga é quem administra o servidor, em `/admin/sistema`.
 *
 * #4871 (F2 do #3868): a recusa passa a considerar a linha DESTA empresa em
 * `organization_modules`. A instalação continua sendo o teto; a empresa que o
 * administrador da instalação desligou não abre a tela mesmo com a instalação
 * ligada. Sem linha da empresa, herda a instalação — nada muda para quem nunca
 * configurou.
 */
export default async function Layout({ children }: { children: React.ReactNode }) {
  // `resolveActiveOrg` é `cache()` por requisição: o layout de `/app` já
  // resolveu a mesma organização, e esta chamada não paga outra leitura.
  const activeOrg = await resolveActiveOrg(await requireAuth());
  if (!(await moduloLigado(createAdminClient(), "crm_b2b", activeOrg?.orgId))) notFound();
  return children;
}
