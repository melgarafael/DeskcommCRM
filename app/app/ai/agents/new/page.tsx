import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { listSelectableChannels } from "@/lib/channels/selectable";
import { createClient } from "@/lib/supabase/server";
import type { CredentialRow } from "@/hooks/ai/useCredentials";
import type { ModelOption } from "../[id]/_components/ModelPicker";

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
  const [credentialsRes, channelSessions, catalogoRes] = await Promise.all([
    supabase
      .from("ai_provider_credentials_safe")
      .select(CREDENTIAL_COLUMNS)
      .eq("organization_id", activeOrg.orgId),
    listSelectableChannels(supabase, activeOrg.orgId),
    supabase
      .from("ai_models")
      .select("provider, model_id, display_name, context_window, is_default_for_provider")
      .is("deprecated_at", null),
  ]);

  const credentials = (credentialsRes.data ?? []) as unknown as CredentialRow[];
  const catalogo = ((catalogoRes.data ?? []) as Array<{
    provider: string;
    model_id: string;
    display_name: string | null;
    context_window: number | null;
    is_default_for_provider: boolean | null;
  }>).map(
    (m): ModelOption => ({
      provider: m.provider as ModelOption["provider"],
      model_id: m.model_id,
      display_name: m.display_name ?? m.model_id,
      context_window: m.context_window,
      is_default_for_provider: Boolean(m.is_default_for_provider),
    }),
  );

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <AgentForm
        mode="create"
        credentials={credentials}
        provedoresDaInstalacao={provedoresDaInstalacao()}
        catalogo={catalogo}
        channelSessions={channelSessions}
      />
    </div>
  );
}
