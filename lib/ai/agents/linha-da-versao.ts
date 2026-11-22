/**
 * A LINHA de uma versão de agente: as colunas que se leem e o mapeamento dela
 * para o pedido de um rascunho clonado. Puro, sem import nenhum — de propósito.
 *
 * Mora fora de `edicao.ts` porque as ferramentas MCP de editar assistentes
 * (`lib/mcp/tools/agentes.ts`) precisam disto no carregamento, e `edicao.ts`
 * puxa `publish.ts` → `lib/ai/runtime/agent.ts` → a lista de ferramentas MCP:
 * importado estaticamente pelas próprias ferramentas, fecharia um ciclo em que
 * a lista nasce com um buraco. As ferramentas carregam `edicao.ts` sob demanda.
 */
export const VERSION_COLUMNS =
  "id, organization_id, agent_id, version_number, system_prompt, provider, model, credential_id, tool_ids, trigger_config, channel_session_id, max_steps, token_budget, cost_budget_cents, history_message_window, history_token_window, handoff_keywords, handoff_tool_enabled, handoff_legal_enabled, proposal_ai_draft_enabled, cases_enabled, split_messages, split_max_chars, followup, voz_enabled, voz_quando, operator_enabled, operator_model, operator_tool_ids, status, published_at, superseded_at, created_at, created_by,pipeline_ids,knowledge_source_ids,skill_names,image_vision_enabled,provisioning_origin,inbound_debounce_ms,reply_min_interval_ms";

/** Os campos de uma versão que viram o pedido de um rascunho clonado dela. */
export interface LinhaDaVersao {
  system_prompt: string;
  provider: string;
  model: string;
  credential_id: string | null;
  tool_ids: string[] | null;
  trigger_config: Record<string, unknown> | null;
  channel_session_id: string | null;
  max_steps: number;
  token_budget: number;
  cost_budget_cents: number;
  history_message_window: number;
  history_token_window: number;
  handoff_keywords: string[] | null;
  handoff_tool_enabled: boolean;
  handoff_legal_enabled: boolean | null;
  image_vision_enabled: boolean | null;
  proposal_ai_draft_enabled: boolean;
  cases_enabled: boolean;
  operator_enabled: boolean;
  operator_model: string | null;
  operator_tool_ids: string[] | null;
  pipeline_ids: string[] | null;
  knowledge_source_ids: string[] | null;
  skill_names: string[] | null;
  split_messages: boolean;
  split_max_chars: number;
  inbound_debounce_ms: number | null;
  reply_min_interval_ms: number | null;
  followup: unknown;
  voz_enabled: boolean;
  voz_quando: "nunca" | "espelhar" | "sempre" | "quando_pede";
}

/**
 * A linha de uma versão como INSERT de um rascunho novo — o mesmo mapeamento
 * que `revertToVersionAction` sempre fez (nulos de colunas antigas viram o
 * padrão da coluna).
 */
export function linhaDoRascunhoClonado(src: LinhaDaVersao): Record<string, unknown> {
  return {
    system_prompt: src.system_prompt,
    provider: src.provider,
    model: src.model,
    credential_id: src.credential_id,
    tool_ids: src.tool_ids,
    trigger_config: src.trigger_config ?? undefined,
    channel_session_id: src.channel_session_id,
    max_steps: src.max_steps,
    token_budget: src.token_budget,
    cost_budget_cents: src.cost_budget_cents,
    history_message_window: src.history_message_window,
    history_token_window: src.history_token_window,
    handoff_keywords: src.handoff_keywords,
    handoff_tool_enabled: src.handoff_tool_enabled,
    handoff_legal_enabled: src.handoff_legal_enabled,
    image_vision_enabled: src.image_vision_enabled ?? true,
    proposal_ai_draft_enabled: src.proposal_ai_draft_enabled,
    cases_enabled: src.cases_enabled,
    operator_enabled: src.operator_enabled,
    operator_model: src.operator_model,
    operator_tool_ids: src.operator_tool_ids,
    pipeline_ids: src.pipeline_ids,
    knowledge_source_ids: src.knowledge_source_ids ?? [],
    skill_names: src.skill_names ?? null,
    split_messages: src.split_messages,
    split_max_chars: src.split_max_chars,
    inbound_debounce_ms: src.inbound_debounce_ms ?? null,
    reply_min_interval_ms: src.reply_min_interval_ms ?? null,
    followup: src.followup,
    voz_enabled: src.voz_enabled,
    voz_quando: src.voz_quando,
  };
}
