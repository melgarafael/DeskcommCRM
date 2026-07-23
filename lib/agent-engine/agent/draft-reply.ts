/**
 * Onda 5.1 — rascunho da IA no composer (sob demanda, sem envio). Via LIMPA:
 * reusa loadPublishedAgentConfig + getLeadContext + runModelCall SEM tools —
 * `result.text` já é o rascunho. NÃO reconstrói o toolset/playbook/checkpoint
 * do turno completo (inbound-turn.ts) e NÃO invoca guardrails de anti-ban/
 * disclosure/send: o texto é revisado por um humano antes de sair, então essa
 * camada não se aplica aqui.
 */
import type pg from 'pg';
import type { ModelMessage } from 'ai';

import { loadPublishedAgentConfig } from './agent-config';
import { getLeadContext } from '../edge/crm/get-lead-context';
import type { CrmEdgeConfig } from '../edge/crm/mcp-client';
import { runModelCall, type LlmEdgeConfig } from '../edge/llm/run-model-call';

export interface DraftReplyInput {
  tenantId: string; // = organization_id
  leadId: string; // = contact_id
  conversationId: string;
  channelSessionId: string;
}

export type DraftReplyResult =
  | { ok: true; draft: string }
  | { ok: false; reason: 'no_agent' | 'blocked' | 'empty' };

export async function generateDraftReply(
  db: pg.Pool,
  llmCfg: LlmEdgeConfig,
  crmCfg: CrmEdgeConfig,
  input: DraftReplyInput,
): Promise<DraftReplyResult> {
  const agent = await loadPublishedAgentConfig(db, input.tenantId, input.channelSessionId);
  if (agent === null) return { ok: false, reason: 'no_agent' };

  const ctx = await getLeadContext(
    db,
    crmCfg,
    { tenantId: input.tenantId, leadId: input.leadId, conversationId: input.conversationId },
    // knobs reais da versão publicada — mesmos usados pelo turno completo
    // (inbound-turn.ts), sem número mágico: historyMessageWindow/historyTokenWindow
    // já são exatamente os campos que LeadContextKnobs espera.
    { historyLimit: agent.historyMessageWindow, maxTokens: agent.historyTokenWindow },
  );
  // ok:false (lead_not_found/crm_error/crm_unavailable) colapsa em "blocked":
  // sem contexto confiável não há rascunho seguro, e o contrato de
  // DraftReplyResult não tem um reason próprio para erro de leitura do CRM.
  if (!ctx.ok || ctx.context.contact.is_blocked || ctx.lgpd.isAnonymized) {
    return { ok: false, reason: 'blocked' };
  }

  const system =
    `${agent.systemPrompt}\n\n` +
    `[MODO RASCUNHO] Gere UMA resposta pronta para o vendedor humano enviar ao cliente. ` +
    `Escreva como o vendedor (NÃO se identifique como assistente/IA, NÃO use disclosure de bot). ` +
    `Responda só com o texto da mensagem, sem aspas nem comentários.`;

  const messages: ModelMessage[] = ctx.context.messages.map((m) => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.body,
  }));

  const { result } = await runModelCall(db, llmCfg, {
    tenantId: input.tenantId,
    leadId: input.leadId,
    jobId: null,
    purpose: 'draft_suggestion',
    system,
    messages,
    model: agent.model,
    llmOverride: { provider: agent.provider, credentialId: agent.credentialId },
    // SEM tools, SEM maxSteps → o SDK para no 1º step (default stepCountIs(1)):
    // result.text vem pronto, sem risco do modelo tentar chamar send_message.
  });

  const draft = (result.text ?? '').trim();
  if (!draft) return { ok: false, reason: 'empty' };
  return { ok: true, draft };
}
