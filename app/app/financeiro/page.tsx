import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";

import { FinanceiroClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * FINANCEIRO — contas a receber como entidade (0233).
 *
 * Sem sidebar de propósito (doutrina da dobra, como Títulos e Faturamento):
 * a porta é o ⌘K e os links (pedido, cliente, Títulos).
 */
export default async function FinanceiroPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const podeRegistrar = user.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  return <FinanceiroClient podeRegistrar={podeRegistrar} />;
}
