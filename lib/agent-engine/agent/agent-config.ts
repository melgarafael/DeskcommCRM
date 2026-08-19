/**
 * Config do agente por PONTEIRO PUBLICADO (Fase 2B da fusão) — a tela
 * app/app/ai/agents/[id] é a fonte de verdade da config do agente.
 *
 * Contrato:
 *   - resolvida no início de CADA turno (zero cache de processo): publicar na
 *     tela ⇒ o PRÓXIMO turno já usa a versão nova;
 *   - a versão publicada é imutável no banco (trigger da 0051) — mesma garantia
 *     versões-imutáveis+ponteiro do harness (0050);
 *   - seleção espelha o dispatcher do CRM: org + não-arquivado + published_version_id
 *     preenchido + binding da channel_session do job, ordenado por priority desc;
 *   - org e channel_session vêm de fonte confiável (row do job), nunca de payload;
 *   - sem agente publicado para a sessão ⇒ null (o turno cai no comportamento
 *     de fallback: playbook por ponteiro + settings.llm da org + knobs de env).
 */
import type pg from 'pg';

import { lerJanelaDeAtendimento, type JanelaDeAtendimento } from './janela-de-atendimento';

export interface PublishedAgentConfig {
  agentId: string;
  versionId: string;
  agentName: string;
  systemPrompt: string;
  provider: string;
  model: string;
  credentialId: string | null;
  maxSteps: number;
  historyMessageWindow: number;
  historyTokenWindow: number;
  handoffKeywords: string[];
  handoffToolEnabled: boolean;
  splitMessages: boolean;
  splitMaxChars: number;
  /** input multimodal (imagem/áudio/pdf) habilitado no turno (Onda 3). */
  multimodalInput: boolean;
  /** tools open_human_case/provide_case_update habilitadas no turno (spec 15). */
  casesEnabled: boolean;
  /** tool_ids do catálogo MCP habilitadas na tela (2B-tools). */
  toolIds: string[];
  /** KB ativa do agente (ai_agents.active_kb_version_id) — null = sem RAG. */
  activeKbVersionId: string | null;
  /** knobs de RAG do ai_agents.config (defaults do guardrails-schema: 5 / 0.72). */
  ragTopK: number;
  ragSimilarityThreshold: number;
  /**
   * O papel OPERADOR está ligado nesta versão (spec 16 §3.2)?
   *
   * Default do banco é FALSE: um papel que gasta uma chamada de modelo por turno
   * na chave do self-hoster não se liga por migration, se liga na tela.
   */
  operatorEnabled: boolean;
  /** modelo do papel Operador. `null` = herda `model` (o do Conversador). */
  operatorModel: string | null;
  /**
   * Capacidades do papel Operador — INDEPENDENTES de `toolIds` (do Conversador).
   * Vazio = o papel roda sem mão, que é estado legítimo e observável: ele ainda
   * registra promessa em aberto. Herdar as do Conversador daria 20 capacidades a
   * quem não escolheu nenhuma.
   */
  operatorToolIds: string[];
  /**
   * Funis em que o agente pode ESCREVER (spec 17 passo 3). Vazio = NENHUM.
   * Lido pelo gate em `lib/leads/escopo-de-funil.ts`.
   */
  pipelineIds: string[];
  /**
   * Horário de funcionamento declarado na tela (`trigger_config.filters.business_hours`).
   * `null` = atende a qualquer hora. Quem obedece é o turno inbound, adiando o
   * job para a abertura — ver `janela-de-atendimento.ts` para o defeito que isto
   * conserta (o campo existia na tela e nenhum leitor vivo o consultava).
   */
  janelaDeAtendimento: JanelaDeAtendimento | null;
  /** criadores (p/ mint do token efêmero de audit — padrão do runtime nativo). */
  versionCreatedBy: string | null;
  agentCreatedBy: string | null;
}

interface Row {
  agent_id: string;
  version_id: string;
  agent_name: string;
  system_prompt: string;
  provider: string;
  model: string;
  credential_id: string | null;
  max_steps: number;
  history_message_window: number;
  history_token_window: number;
  handoff_keywords: string[] | null;
  handoff_tool_enabled: boolean;
  split_messages: boolean;
  split_max_chars: number;
  multimodal_input: boolean;
  cases_enabled: boolean;
  tool_ids: string[] | null;
  active_kb_version_id: string | null;
  config: Record<string, unknown> | null;
  operator_enabled: boolean | null;
  operator_model: string | null;
  operator_tool_ids: string[] | null;
  pipeline_ids: string[] | null;
  trigger_config: unknown;
  version_created_by: string | null;
  agent_created_by: string | null;
}

const SELECT_AGENT_CONFIG_COLUMNS = `a.id as agent_id,
            v.id as version_id,
            a.name as agent_name,
            v.system_prompt,
            v.provider,
            v.model,
            v.credential_id,
            v.max_steps,
            v.history_message_window,
            v.history_token_window,
            v.handoff_keywords,
            v.handoff_tool_enabled,
            v.split_messages,
            v.split_max_chars,
            v.multimodal_input,
            v.cases_enabled,
            v.tool_ids,
            a.active_kb_version_id,
            a.config,
            v.operator_enabled,
            v.operator_model,
            v.operator_tool_ids,
            v.pipeline_ids,
            v.trigger_config,
            v.created_by as version_created_by,
            a.created_by as agent_created_by`;

/** Mapeamento Row (snake_case do banco) → PublishedAgentConfig, compartilhado
 * pelas duas variantes de loader (por channel_session e por agent id). */
function mapAgentConfigRow(r: Row): PublishedAgentConfig {
  const cfg = (r.config ?? {}) as { rag_top_k?: unknown; rag_similarity_threshold?: unknown };
  const ragTopK =
    typeof cfg.rag_top_k === 'number' && Number.isInteger(cfg.rag_top_k) && cfg.rag_top_k >= 1 && cfg.rag_top_k <= 20
      ? cfg.rag_top_k
      : 5;
  const ragSimilarityThreshold =
    typeof cfg.rag_similarity_threshold === 'number' && cfg.rag_similarity_threshold >= 0 && cfg.rag_similarity_threshold <= 1
      ? cfg.rag_similarity_threshold
      : 0.72;

  return {
    agentId: r.agent_id,
    versionId: r.version_id,
    agentName: r.agent_name,
    systemPrompt: r.system_prompt,
    provider: r.provider,
    model: r.model,
    credentialId: r.credential_id,
    maxSteps: r.max_steps,
    historyMessageWindow: r.history_message_window,
    historyTokenWindow: r.history_token_window,
    handoffKeywords: (r.handoff_keywords ?? []).map((k) => k.toLowerCase().trim()).filter((k) => k !== ''),
    handoffToolEnabled: r.handoff_tool_enabled,
    splitMessages: r.split_messages,
    splitMaxChars: r.split_max_chars,
    multimodalInput: r.multimodal_input,
    casesEnabled: r.cases_enabled,
    toolIds: r.tool_ids ?? [],
    activeKbVersionId: r.active_kb_version_id,
    ragTopK,
    ragSimilarityThreshold,
    // `?? false` cobre o clone que ainda não aplicou a 0111: coluna ausente vem
    // como null/undefined, e a direção segura é o papel DESLIGADO — nunca gastar
    // modelo por causa de um schema desatualizado.
    operatorEnabled: r.operator_enabled ?? false,
    operatorModel: r.operator_model,
    // `?? []` cobre o clone sem a 0112: sem coluna, o papel roda sem mão em vez
    // de herdar a lista do Conversador — a direção segura é agir de menos.
    operatorToolIds: r.operator_tool_ids ?? [],
    // `?? []` = NENHUM funil. O clone que ainda não aplicou a 0125 nasce
    // fechado — a direção segura é agir de menos (mesma decisão da linha acima).
    pipelineIds: r.pipeline_ids ?? [],
    // Leitura DEFENSIVA e que falha ABERTA: jsonb livre com shape estranho vira
    // `null` (sem janela ⇒ atende sempre), nunca uma mordaça acidental.
    janelaDeAtendimento: lerJanelaDeAtendimento(r.trigger_config),
    versionCreatedBy: r.version_created_by,
    agentCreatedBy: r.agent_created_by,
  };
}

export async function loadPublishedAgentConfig(
  db: pg.Pool,
  organizationId: string,
  channelSessionId: string,
): Promise<PublishedAgentConfig | null> {
  const { rows } = await db.query<Row>(
    `select ${SELECT_AGENT_CONFIG_COLUMNS}
     from ai_agents a
     join ai_agent_versions v on v.id = a.published_version_id
     where a.organization_id = $1
       and a.archived_at is null
       -- is_active é semântica do rag_bot legado; para mcp_agent "ativo" =
       -- published_version_id preenchido + não arquivado (mesmo critério do
       -- dispatcher nativo do CRM — pausar = despublicar).
       and v.status = 'published'
       and v.channel_session_id = $2
     order by a.priority desc, a.created_at asc
     limit 1`,
    [organizationId, channelSessionId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return mapAgentConfigRow(r);
}

/**
 * Variante por agent_id — usada pelo Intent Router (Fase 3): membros de
 * router (`ai_router_members.agent_id`) apontam pro agente diretamente, sem
 * vínculo com a channel_session do turno (quem tem o vínculo é o ROUTER, não
 * o agente-membro). `id` é único, então sem order/limit.
 */
export async function loadPublishedAgentConfigById(
  db: pg.Pool,
  organizationId: string,
  agentId: string,
): Promise<PublishedAgentConfig | null> {
  const { rows } = await db.query<Row>(
    `select ${SELECT_AGENT_CONFIG_COLUMNS}
     from ai_agents a
     join ai_agent_versions v on v.id = a.published_version_id
     where a.organization_id = $1
       and a.archived_at is null
       and v.status = 'published'
       and a.id = $2`,
    [organizationId, agentId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return mapAgentConfigRow(r);
}

/**
 * Detecção de handoff por keywords CONFIGURADAS na tela (soma-se à detecção
 * determinística regex do engine — nunca a substitui). Case-insensitive,
 * substring simples: a semântica do EPIC-13 (sentinel de handoff_keywords).
 */
export function matchesHandoffKeyword(signal: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return false;
  const lower = signal.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}
