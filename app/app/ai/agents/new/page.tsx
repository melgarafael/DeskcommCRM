import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { listSelectableChannels } from "@/lib/channels/selectable";
import { createClient } from "@/lib/supabase/server";
import type { CredentialRow } from "@/hooks/ai/useCredentials";

import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { resolveAgentCreationDefaults } from "@/lib/ai/agents/creation-defaults";
import { chaveDePlataforma } from "@/lib/ai/runtime/agent";

import { lerAmbiente } from "@/lib/instalacao/ambiente";

import { ConversationalAgentCreator } from "./_components/ConversationalAgentCreator";

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
    .filter(([id, tem]) => tem && !!chaveDePlataforma(id))
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
  const [credentialsRes, channelSessions] = await Promise.all([
    supabase
      .from("ai_provider_credentials_safe")
      .select(CREDENTIAL_COLUMNS)
      .eq("organization_id", activeOrg.orgId),
    listSelectableChannels(supabase, activeOrg.orgId),
  ]);

  const credentials = (credentialsRes.data ?? []) as unknown as CredentialRow[];

  const platformProviders = provedoresDaInstalacao();
  const db = await getRequestPool().connect();
  let defaultAI;
  try {
    defaultAI = await resolveAgentCreationDefaults(db, activeOrg.orgId, platformProviders);
  } finally {
    db.release();
  }

  return (
    <div className="flex h-full flex-col gap-6 p-4 sm:p-6">
      <ConversationalAgentCreator
        credentials={credentials}
        provedoresDaInstalacao={platformProviders}
        defaultAI={defaultAI}
        channelSessions={channelSessions}
      />
    </div>
  );
}
