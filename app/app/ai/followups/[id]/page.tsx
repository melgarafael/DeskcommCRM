import { notFound, redirect } from "next/navigation";

import { carregarFluxoParaEdicao } from "@/lib/followup/editar";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { FlowBuilder } from "./_components/FlowBuilder";

export const dynamic = "force-dynamic";

/**
 * Editor de um fluxo de FOLLOW-UP. A leitura é a MESMA do editor de atendimento
 * (`carregarFluxoParaEdicao`): uma lista de colunas própria aqui já deixou o
 * `send_when_assigned` de fora, e o switch abria desligado com o banco ligado.
 */
export default async function FollowupFlowBuilderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const flow = await carregarFluxoParaEdicao(supabase, { orgId: activeOrg.orgId, id });
  // Roteiro de atendimento não abre no editor de follow-up (prova do #1130).
  if (!flow || flow.surface === "atendimento") notFound();

  return (
    <div className="flex h-full flex-col">
      <FlowBuilder flowId={id} initialData={flow} />
    </div>
  );
}
