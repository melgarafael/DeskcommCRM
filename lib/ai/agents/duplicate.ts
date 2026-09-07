/**
 * Duplicação de agente — UMA implementação para os dois chamadores.
 *
 * Existiam duas: `POST /api/v1/ai/agents/:id/duplicate` clonava agente + versão
 * (Spec 10 §4.3), e `duplicateAgentAction` (o botão "Duplicar" da lista) fazia
 * cópia rasa só da linha de `ai_agents`. Para `mcp_agent` isso entrega uma casca:
 * prompt, ferramentas, credencial, canal, palavras de handoff, budgets e vínculo
 * de follow-up vivem TODOS em `ai_agent_versions`. O usuário duplicava e recebia
 * um agente em branco — e a UI é o caminho que as pessoas realmente usam.
 *
 * A escolha da versão de origem é a da rota: draft mais recente; sem draft, a
 * published. A cópia nasce sempre como draft v1 — duplicar não publica nada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const DUPLICATE_AGENT_COLUMNS =
  "id, organization_id, name, description, model, system_prompt, is_active, is_default, kind, priority, published_version_id, archived_at, config, guardrails, active_kb_version_id, created_at, updated_at";

/**
 * Uma das cópias da lista de colunas de `ai_agent_versions` vigiadas por
 * `tests/unit/agent-version-columns-drift.test.ts` — antes desta extração ela
 * vivia inline em `duplicate/route.ts`, e o teste aponta para cá desde então.
 * Coluna nova entra aqui E em `versionPayloadFrom`: o SELECT trazer a coluna não
 * basta, se o INSERT não a escreve a cópia nasce com o default do banco.
 */
export const DUPLICATE_VERSION_COLUMNS =
  "id, organization_id, agent_id, version_number, system_prompt, provider, model, credential_id, tool_ids, trigger_config, channel_session_id, max_steps, token_budget, cost_budget_cents, history_message_window, history_token_window, handoff_keywords, handoff_tool_enabled, cases_enabled, split_messages, split_max_chars, followup, operator_enabled, operator_model, operator_tool_ids, status, published_at, superseded_at, created_at, created_by,pipeline_ids,knowledge_source_ids,provisioning_origin";

export type DuplicateAgentError =
  | "not_found"
  | "no_version_to_duplicate"
  | "agent_insert_failed"
  | "version_insert_failed";

export type DuplicateAgentResult =
  | {
      ok: true;
      agent: Record<string, unknown>;
      version: Record<string, unknown> | null;
      /**
       * Versão de ORIGEM que foi clonada — não a nova. Existe para o audit poder
       * responder "cópia de qual versão?", que `version` (a nova) não responde.
       *
       * `null` quando não havia versão a copiar (rag_bot legado).
       */
      sourceVersionId: string | null;
    }
  | { ok: false; error: DuplicateAgentError; message?: string };

/**
 * Campos da versão que são copiados. Lista explícita (e não spread do row) porque
 * `id`, `version_number`, `status`, `published_at` e `superseded_at` NÃO podem
 * vazar da origem — a cópia é sempre uma draft nova.
 */
function versionPayloadFrom(src: Record<string, unknown>) {
  return {
    system_prompt: src.system_prompt,
    provider: src.provider,
    model: src.model,
    credential_id: src.credential_id,
    tool_ids: src.tool_ids,
    trigger_config: src.trigger_config,
    channel_session_id: src.channel_session_id,
    max_steps: src.max_steps,
    token_budget: src.token_budget,
    cost_budget_cents: src.cost_budget_cents,
    history_message_window: src.history_message_window,
    history_token_window: src.history_token_window,
    handoff_keywords: src.handoff_keywords,
    handoff_tool_enabled: src.handoff_tool_enabled,
    cases_enabled: src.cases_enabled,
    // Papel Operador (spec 16). Duplicar um agente tem de duplicar o papel
    // inteiro: sem estas três, a cópia nasce com o Operador desligado e o dono
    // descobre isso quando o clone não organiza nada.
    operator_enabled: src.operator_enabled,
    operator_model: src.operator_model,
    operator_tool_ids: src.operator_tool_ids,
    split_messages: src.split_messages,
    split_max_chars: src.split_max_chars,
    followup: src.followup,
    // ESCOPO. As duas faltavam — `pipeline_ids` desde a 0125, e o cabeçalho
    // deste arquivo já mandava ("coluna nova entra aqui E em
    // versionPayloadFrom"). O SELECT trazia a coluna e o INSERT não a escrevia:
    // a cópia nascia com o default do banco, que é VAZIO. Duplicar um assistente
    // produzia um clone que não mexe em funil nenhum e não conhece material
    // nenhum — e o dono descobria isso no primeiro atendimento do clone.
    pipeline_ids: src.pipeline_ids ?? [],
    knowledge_source_ids: src.knowledge_source_ids ?? [],
  };
}

/** Versão de origem: draft mais recente; sem draft, a published. `null` = agente sem versão. */
export async function pickSourceVersion(
  admin: SupabaseClient,
  orgId: string,
  agentId: string,
): Promise<Record<string, unknown> | null> {
  const { data: draft } = await admin
    .from("ai_agent_versions")
    .select(DUPLICATE_VERSION_COLUMNS)
    .eq("organization_id", orgId)
    .eq("agent_id", agentId)
    .eq("status", "draft")
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (draft) return draft as Record<string, unknown>;

  const { data: published } = await admin
    .from("ai_agent_versions")
    .select(DUPLICATE_VERSION_COLUMNS)
    .eq("organization_id", orgId)
    .eq("agent_id", agentId)
    .eq("status", "published")
    .limit(1)
    .maybeSingle();
  return (published as Record<string, unknown> | null) ?? null;
}

export async function duplicateAgentWithVersion(
  admin: SupabaseClient,
  input: { orgId: string; agentId: string; actorUserId: string; requireVersion: boolean },
): Promise<DuplicateAgentResult> {
  const { orgId, agentId, actorUserId, requireVersion } = input;

  const { data: srcAgent } = await admin
    .from("ai_agents")
    .select(DUPLICATE_AGENT_COLUMNS)
    .eq("id", agentId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!srcAgent) return { ok: false, error: "not_found" };

  const src = srcAgent as Record<string, unknown>;
  const isMcp = src.kind === "mcp_agent";
  const srcVersion = isMcp ? await pickSourceVersion(admin, orgId, agentId) : null;

  // A rota da API trata "sem versão" como 409; o botão da lista precisa seguir
  // duplicando o rag_bot legado, que não tem versão nenhuma por natureza.
  if (isMcp && !srcVersion && requireVersion) {
    return { ok: false, error: "no_version_to_duplicate" };
  }

  const { data: newAgent, error: agentErr } = await admin
    .from("ai_agents")
    .insert({
      organization_id: orgId,
      name: `${String(src.name)} (cópia)`.slice(0, 120),
      description: src.description,
      model: src.model,
      system_prompt: src.system_prompt,
      kind: src.kind ?? "rag_bot",
      priority: src.priority ?? 0,
      // Cópia nasce fora do ar: sem published_version_id, nenhum runtime a enxerga.
      is_active: isMcp ? true : false,
      is_default: false,
      config: src.config ?? {},
      guardrails: src.guardrails ?? null,
      active_kb_version_id: src.active_kb_version_id,
      created_by: actorUserId,
    })
    .select(DUPLICATE_AGENT_COLUMNS)
    .single();

  if (agentErr || !newAgent) {
    return { ok: false, error: "agent_insert_failed", message: agentErr?.message };
  }

  if (!srcVersion)
    return {
      ok: true,
      agent: newAgent as Record<string, unknown>,
      version: null,
      sourceVersionId: null,
    };

  const { data: newVersion, error: versionErr } = await admin
    .from("ai_agent_versions")
    .insert({
      organization_id: orgId,
      agent_id: (newAgent as { id: string }).id,
      version_number: 1,
      ...versionPayloadFrom(srcVersion),
      status: "draft",
      created_by: actorUserId,
    })
    .select(DUPLICATE_VERSION_COLUMNS)
    .single();

  if (versionErr || !newVersion) {
    // Sem a versão, a cópia é a casca que este módulo existe para não produzir.
    await admin
      .from("ai_agents")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", (newAgent as { id: string }).id);
    return { ok: false, error: "version_insert_failed", message: versionErr?.message };
  }

  return {
    ok: true,
    agent: newAgent as Record<string, unknown>,
    version: newVersion as Record<string, unknown>,
    sourceVersionId: (srcVersion as { id: string }).id,
  };
}
