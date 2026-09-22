import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";

import { TarefasClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * TAREFAS — a rotina do vendedor externo: agendadas, check-in e atividades
 * realizadas. Sem sidebar (doutrina da dobra): a porta é o ⌘K.
 */
export default async function TarefasPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const podeRegistrar = user.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;
  return <TarefasClient podeRegistrar={podeRegistrar} />;
}
