/**
 * Tools MCP habilitadas NA TELA entrando no turno do engine (Fase 2B-tools).
 *
 * Reusa a MESMA ponte in-process do runtime nativo (lib/ai/runtime/tools:
 * pickToolsFromMcp) — audit em api_audit_log, ensureRole/ensureScope e redação
 * de PII idênticos. O actor do audit é o ai_agents.id do agente publicado, com
 * token efêmero mintado pelo padrão do repo (TTL curto, revogado no fim do turno).
 *
 * FILTRO DE SEGURANÇA (inegociável, não é knob):
 *   - crm_send_whatsapp_message NUNCA entra: enviar é SEMPRE a tool send_message
 *     do engine, atrás da cadeia runBeforeSend (CLAUDE.md princípio 2) — uma tool
 *     de envio por fora furaria anti-ban/opt-out/disclosure inteiros;
 *   - crm_request_human_handoff NUNCA entra (e a auto-injeção da ponte fica
 *     desligada): o engine tem a própria request_human_handoff com silêncio
 *     durável + cancelamento de follow-ups — duas tools de handoff confundiriam
 *     o modelo e a variante do CRM não silencia o harness.
 */
import type { Tool } from 'ai';

import { pickToolsFromMcp, type RuntimeHandoffSignal } from '@/lib/ai/runtime/tools';
import { mintEphemeralToken, revokeEphemeralToken } from '@/lib/ai/runtime/mcp_token';
import type { McpAuthResult } from '@/lib/mcp/auth';
import type { McpContext } from '@/lib/mcp/types';

import type { Logger } from '../../obs/logger';
import type { CrmEdgeConfig } from './mcp-client';
import type { PublishedAgentConfig } from '../../agent/agent-config';

/** Tools do catálogo que jamais entram no turno do engine (ver doc acima). */
const BLOCKED_TOOL_IDS = new Set(['crm_send_whatsapp_message', 'crm_request_human_handoff']);

export interface McpTurnTools {
  tools: Record<string, Tool>;
  /** ids efetivamente montados (para o log do turno — auditável). */
  toolIds: string[];
  /** revoga o token efêmero — chamar no fim do turno (caminho feliz). */
  cleanup: () => Promise<void>;
}

export async function buildMcpTurnTools(
  cfg: CrmEdgeConfig,
  ids: { organizationId: string; jobId: string },
  agentConfig: PublishedAgentConfig,
  log: Logger,
): Promise<McpTurnTools | null> {
  const allowed = agentConfig.toolIds.filter((id) => !BLOCKED_TOOL_IDS.has(id));
  const blocked = agentConfig.toolIds.filter((id) => BLOCKED_TOOL_IDS.has(id));
  if (blocked.length > 0) {
    // A tela permite marcar; o engine recusa em silêncio NUNCA — loga o porquê.
    log.warn('tools MCP bloqueadas no turno do engine (envio/handoff são do harness)', {
      blocked_tool_ids: blocked,
    });
  }
  if (allowed.length === 0) {
    return null;
  }

  const ephemeral = await mintEphemeralToken({
    organizationId: ids.organizationId,
    runId: ids.jobId,
    versionCreatedBy: agentConfig.versionCreatedBy ?? undefined,
    agentCreatedBy: agentConfig.agentCreatedBy ?? undefined,
  });

  const ctx: McpContext = {
    organizationId: ids.organizationId,
    role: 'agent',
    actor: { type: 'ai_agent', id: agentConfig.agentId, role: 'agent', api_token_id: ephemeral.id },
    apiTokenId: ephemeral.id,
    requestId: ids.jobId,
    supabase: cfg.supabase,
  };
  const auth: McpAuthResult = {
    organizationId: ids.organizationId,
    role: 'agent',
    actor: ctx.actor,
    apiTokenId: ephemeral.id,
    scopes: ['mcp:read', 'mcp:write', 'actor:ai_agent'],
  };
  // O engine não usa o sinal de handoff da ponte (a tool está bloqueada) — dummy.
  const handoffSignal: RuntimeHandoffSignal = { triggered: false };

  const tools = pickToolsFromMcp({
    supabase: cfg.supabase,
    ctx,
    auth,
    toolIds: allowed,
    handoffToolEnabled: false,
    handoffSignal,
  });

  return {
    tools,
    toolIds: Object.keys(tools),
    // ponytail: revoke só no caminho feliz — em crash do turno o token expira
    // pelo TTL curto do mint (mesmo tradeoff aceito pelo runtime nativo no grace).
    cleanup: async () => {
      try {
        await revokeEphemeralToken(ephemeral.id);
      } catch {
        // token expira sozinho; revogação é higiene, não invariante.
      }
    },
  };
}
