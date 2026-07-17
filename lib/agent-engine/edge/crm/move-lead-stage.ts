/**
 * Espelho do avanço de funil no kanban do CRM. O harness (lead_state) é a fonte
 * da verdade do funil do agente; o espelho no kanban do Deskcomm (crm_leads/
 * pipelines) entra na Fase 2 da fusão, junto da tela de config.
 *
 * ponytail: 'not_configured' é o estado DELIBERADO da Fase 0/1 — o caller
 * (inbound-turn) trata como warn-only, sem inbox nem falha de job.
 */
import type { Queryable } from '../../queue/queue';
import type { CrmEdgeConfig } from './mcp-client';
import type { LeadStage } from '../../agent/lead-state';

export type MirrorResult =
  | { ok: true }
  | { ok: false; reason: 'not_configured' | 'crm_error' | 'crm_unavailable'; detail: string };

export async function mirrorLeadStageToCrm(
  _db: Queryable,
  _cfg: CrmEdgeConfig,
  _input: { tenantId: string; leadId: string; toStage: LeadStage; reason?: string },
): Promise<MirrorResult> {
  return { ok: false, reason: 'not_configured', detail: 'espelho de kanban entra na Fase 2 da fusão' };
}
