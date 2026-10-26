/**
 * Sem a capacidade "aprovações da agência", a tela não existe para a organização —
 * 404, como Propostas (`app/app/proposals/layout.tsx`). Só a organização que é
 * cliente da agência a vê (docs/agencia/SPEC-aprovacoes.md, P2).
 */
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { capacidadesDaOrganizacao } from "@/lib/organizacao/capacidades";
import { createAdminClient } from "@/lib/supabase/admin";

export default async function AprovacoesLayout({ children }: { children: ReactNode }) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const ligadas = await capacidadesDaOrganizacao(createAdminClient(), activeOrg.orgId);
  if (!ligadas.includes("aprovacoes_da_agencia")) notFound();
  return <>{children}</>;
}
