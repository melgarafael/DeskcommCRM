import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import type { AgentRow } from "@/hooks/ai/useAgent";
import { AgentsList } from "./_components/AgentsList";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * `versao_publicada` vem por join porque `ai_agents.model` é o valor do CADASTRO:
 * para `mcp_agent`, quem responde é `ai_agent_versions.model` da versão publicada,
 * e publicar não sincroniza a coluna de cima. Sem este join a lista anunciaria
 * para sempre o modelo escolhido no dia da criação.
 */
const AGENT_COLUMNS =
  "id, organization_id, name, description, model, system_prompt, is_active, is_default, kind, priority, published_version_id, paused_at, operation_mode, operation_revision, archived_at, config, guardrails, active_kb_version_id, created_at, updated_at, " +
  "versao_publicada:ai_agent_versions!ai_agents_published_version_id_fkey(provider, model)";

export default async function AgentsListPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ai_agents")
    .select(AGENT_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });

  // Sem ler o `error`, "não consegui perguntar" e "você não tem agente nenhum"
  // pintam a MESMA tela — e a segunda é uma afirmação forte sobre o trabalho de
  // quem instalou. O join por nome de constraint (`versao_publicada`) acrescentou
  // uma causa nova de erro a esta consulta, então a distinção passou a importar.
  // Degradar para lista vazia continua sendo o comportamento (a tela não pode
  // quebrar), mas agora deixa rastro.
  if (error) {
    logger.error("[ai/agents] não consegui listar os agentes — a tela vai parecer vazia", {
      organization_id: activeOrg.orgId,
      detail: error.message.slice(0, 200),
    });
  }

  const agents = (data ?? []) as unknown as AgentRow[];
  const canWrite = ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {traduzir("Agents de IA", idioma)}
          </h1>
          <p className="text-sm text-muted-foreground">
            {traduzir("Configure o comportamento dos agents que respondem no WhatsApp.", idioma)}
          </p>
        </div>
      </header>
      <AgentsList initialData={agents} canWrite={canWrite} />
    </div>
  );
}
