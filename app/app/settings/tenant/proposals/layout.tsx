import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Doc 79: Propostas é módulo opcional da INSTALAÇÃO, além de capacidade da
 * empresa. Com o módulo desligado em /admin/sistema, Configurações › Propostas
 * e os modelos não existem — para nenhuma empresa. Mesmo desenho de
 * `app/app/integracao-dados/layout.tsx`.
 *
 * #4871 (F2 do #3868): a recusa agora considera também a linha DESTA empresa em
 * `organization_modules`, e a instalação continua sendo o teto — desligada lá,
 * esta tela não existe para ninguém; e a empresa que o administrador da
 * instalação desligou também não abre a tela para se ligar sozinha. Sem linha da
 * empresa, herda a instalação: quem nunca configurou não sente diferença.
 *
 * O que esta tela NÃO decide é `settings.proposals.enabled`: é AQUI que a
 * empresa liga a capacidade, então a capacidade desligada não pode fechar a
 * própria porta. Quem fecha a porta de uso é `app/app/proposals/layout.tsx`.
 */
export default async function Layout({ children }: { children: ReactNode }) {
  // `resolveActiveOrg` é `cache()` por requisição: o layout de `/app` já
  // resolveu a mesma organização, e esta chamada não paga outra leitura.
  const activeOrg = await resolveActiveOrg(await requireAuth());
  if (!(await moduloLigado(createAdminClient(), "propostas", activeOrg?.orgId))) notFound();
  return <>{children}</>;
}
