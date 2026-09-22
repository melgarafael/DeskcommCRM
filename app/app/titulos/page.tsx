import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";

import { TitulosClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * TÍTULOS — contas a receber por vencimento, derivadas dos pedidos faturados.
 * Sem sidebar de propósito (doutrina da dobra, como Notas e Recuperação): a
 * porta é o ⌘K e os links do Indicadores.
 */
export default async function TitulosPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const podeDarBaixa = user.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  return <TitulosClient podeDarBaixa={podeDarBaixa} />;
}
