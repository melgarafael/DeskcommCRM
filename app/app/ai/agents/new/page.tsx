import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { listSelectableChannels } from "@/lib/channels/selectable";
import { createClient } from "@/lib/supabase/server";
import type { CredentialRow } from "@/hooks/ai/useCredentials";
import type { FunilDaResposta } from "@/hooks/pipelines/usePipelines";
import { coberturaDoFunil, type EtapaDoMapa } from "@/lib/leads/agent-mapping";
import type { CoberturaPorFunil } from "../[id]/_components/FunisDoAgente";

import { lerAmbiente } from "@/lib/instalacao/ambiente";

import { AgentForm } from "../[id]/_components/AgentForm";

export const dynamic = "force-dynamic";

const CREDENTIAL_COLUMNS =
  "id, organization_id, provider, label, api_key_last4, validated_at, validation_error, models_available, is_active, created_by, created_at, updated_at";

/**
 * Os provedores cuja chave veio na INSTALAÇÃO (`.env`), não da tela de
 * Credenciais.
 *
 * Sai de `lerAmbiente`, a mesma leitura que o retrato da instalação usa — uma
 * segunda lista de nomes de variável divergiria no dia em que um provedor novo
 * entrasse.
 */
function provedoresDaInstalacao(): string[] {
  const a = lerAmbiente();
  return Object.entries(a.chavesDeProvedor)
    .filter(([, tem]) => tem)
    .map(([id]) => id);
}

export default async function NewAgentPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }

  const supabase = await createClient();
  const [credentialsRes, channelSessions, funisRes] = await Promise.all([
    supabase
      .from("ai_provider_credentials_safe")
      .select(CREDENTIAL_COLUMNS)
      .eq("organization_id", activeOrg.orgId),
    listSelectableChannels(supabase, activeOrg.orgId),
    // Mesma leitura que `[id]/page.tsx` — sem isto a aba "Organiza o sistema"
    // mostrava "nenhum funil" mesmo quando existiam, na tela onde o dono
    // decide o funil ANTES de o agente existir.
    supabase
      .from("crm_pipelines")
      .select("id, name, slug, description, position, is_default")
      .eq("organization_id", activeOrg.orgId)
      .eq("is_archived", false)
      .order("position"),
  ]);

  const credentials = (credentialsRes.data ?? []) as unknown as CredentialRow[];
  const funis = (funisRes.data ?? []) as unknown as FunilDaResposta[];

  const { data: etapasRes } = await supabase
    .from("crm_stages")
    .select("id, name, is_won, is_lost, agent_stage_hint, pipeline_id")
    .eq("organization_id", activeOrg.orgId)
    .eq("is_archived", false);
  const etapasPorFunil = new Map<string, EtapaDoMapa[]>();
  for (const e of (etapasRes ?? []) as Array<EtapaDoMapa & { pipeline_id: string }>) {
    etapasPorFunil.set(e.pipeline_id, [...(etapasPorFunil.get(e.pipeline_id) ?? []), e]);
  }
  const cobertura: CoberturaPorFunil = {};
  for (const f of funis) {
    const c = coberturaDoFunil(etapasPorFunil.get(f.id) ?? []);
    cobertura[f.id] = { traduzidos: c.traduzidos, total: c.total, mudo: c.mudo };
  }

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <AgentForm
        mode="create"
        credentials={credentials}
        provedoresDaInstalacao={provedoresDaInstalacao()}
        channelSessions={channelSessions}
        funis={funis}
        cobertura={cobertura}
      />
    </div>
  );
}
