import { notFound, redirect } from "next/navigation";

import { carregarFluxoParaEdicao } from "@/lib/followup/editar";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { FlowBuilder } from "../../followups/[id]/_components/FlowBuilder";

export const dynamic = "force-dynamic";

/**
 * Editor de um fluxo de ATENDIMENTO. Reusa o MESMO construtor dos Follow-ups,
 * mas vive numa rota própria: abrir um fluxo daqui não joga o usuário na lista
 * de Follow-ups (era o que acontecia quando a lista linkava para
 * `/app/ai/followups/<id>`).
 */
export default async function AtendimentoFlowBuilderPage({
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
  // Um fluxo de follow-up não abre aqui (nem um roteiro no editor de follow-up).
  if (!flow || flow.surface !== "atendimento") notFound();

  return (
    <div className="flex h-full flex-col">
      <FlowBuilder flowId={id} initialData={flow} />
    </div>
  );
}
