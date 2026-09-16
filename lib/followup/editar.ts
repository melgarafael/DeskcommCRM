import type { SupabaseClient } from "@supabase/supabase-js";

import type { FollowupFlowDetailRow } from "@/hooks/followup/useFollowupFlow";
import { rascunhoDoFluxo } from "./rascunho";

const DETAIL_COLUMNS =
  "id, name, status, active_version_id, draft_graph, handoff_policy, trigger_config, created_at, updated_at";

/**
 * Carrega o pointer + o rascunho que o editor desenha. Compartilhado pelas duas
 * rotas de edição — `/app/ai/followups/[id]` (retomada) e `/app/ai/atendimento/[id]`
 * (atendimento): o editor é o MESMO, mas a tela (e a rota) de cada superfície é
 * própria, para a navegação não jogar o usuário na lista da outra.
 */
export async function carregarFluxoParaEdicao(
  supabase: SupabaseClient,
  args: { orgId: string; id: string },
): Promise<FollowupFlowDetailRow | null> {
  const [{ data: pointer }, { data: versionRows }] = await Promise.all([
    supabase
      .from("followup_flow_pointers")
      .select(DETAIL_COLUMNS)
      .eq("id", args.id)
      .eq("organization_id", args.orgId)
      .maybeSingle(),
    supabase
      .from("followup_flow_versions")
      .select("id, created_at")
      .eq("organization_id", args.orgId)
      .eq("pointer_id", args.id)
      .order("created_at", { ascending: false }),
  ]);

  if (!pointer) return null;

  // Mesma regra da rota: rascunho ausente COM versão publicada abre o que está
  // NO AR. Ver `lib/followup/rascunho.ts`.
  const draft_graph = await rascunhoDoFluxo(
    supabase,
    pointer as unknown as { draft_graph: unknown; active_version_id: string | null },
    args.orgId,
  );

  return {
    ...(pointer as unknown as Omit<FollowupFlowDetailRow, "versions_count" | "previous_version_id">),
    draft_graph,
    versions_count: versionRows?.length ?? 0,
    previous_version_id: versionRows?.[1]?.id ?? null,
  };
}
