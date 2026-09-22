import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { BudgetCard } from "@/components/ai/BudgetCard";
import { getBudgetStatus } from "@/lib/ai/budget/check";
import { traduzir } from "@/lib/i18n/dicionario";
import { UsageDashboardClient } from "./_client";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function singleParam(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function AiUsagePage({ searchParams }: PageProps) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data: agentRows } = await supabase
    .from("ai_agents")
    .select("id, name, is_default")
    .eq("organization_id", activeOrg.orgId)
    .order("is_default", { ascending: false })
    .order("name", { ascending: true });

  const agents = (agentRows ?? []).map(
    (a: { id: string; name: string; is_default?: boolean | null }) => ({
      id: a.id,
      name: a.name,
    }),
  );

  const sp = await searchParams;
  const initial = {
    agent_id: singleParam(sp.agent_id),
    invocation_kind: singleParam(sp.invocation_kind),
    from: singleParam(sp.from),
    to: singleParam(sp.to),
  };

  const budget = await getBudgetStatus(activeOrg.orgId);
  const isAdmin = ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-text">{traduzir("Uso de IA", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Quanto a inteligência artificial custou, quantos atendimentos ela fez, quanto demorou para responder e quantas vezes precisou chamar uma pessoa — nos últimos 30 dias.",
            idioma,
          )}
        </p>
      </header>
      <BudgetCard initialData={budget} isAdmin={isAdmin} />
      <UsageDashboardClient agents={agents} initial={initial} />
    </div>
  );
}
