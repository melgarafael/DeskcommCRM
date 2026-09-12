import type pg from "pg";

import { buildLeadActivityRow, type ActivityEvidence } from "@/lib/leads/activity-emitter";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";
import type { ActivityType } from "@/lib/leads/activity-vocabulary";

export interface AgentActivityInput {
  pool: pg.Pool;
  organizationId: string;
  /** No harness, "lead" é o CONTATO (inbound-turn: leadId = job.contact_id). */
  contactId: string;
  type: ActivityType;
  reason: string;
  /** O QUE ORIGINOU (um ponteiro), não confundir com evidence. */
  sourceModule: string;
  sourceId?: string | null;
  /** O QUE SUSTENTA. Sem isto a linha entra como 'system' (constraint 0071). */
  evidence?: ActivityEvidence | null;
  agentId?: string | null;
  /**
   * A PESSOA que agiu, quando houve uma.
   *
   * Existe porque nem tudo que o worker registra é ato de máquina. Uma chamada
   * de voz é atendida por um atendente de carne e osso, e a ponte de eventos
   * (`lib/wacalls/events-bridge.ts`) sabe quem — o WaCalls devolve, em `owner`,
   * o `clientId` que NÓS mandamos, que é o `auth.users.id` de quem atendeu.
   *
   * Sem este campo a linha caía em `webhook_source` → `actor_kind='system'`, e a
   * linha do tempo do negócio dizia "Sistema" onde havia um nome. Precede
   * `agentId` na decisão: quando os dois vierem, quem agiu foi a pessoa.
   */
  usuarioId?: string | null;
  payload?: Record<string, unknown>;
}

export type AgentActivityResult =
  | { routed: true; leadId: string }
  | { routed: false; reason: "no_open_lead" | "ambiguous_open_leads" };

/**
 * O motor do agente escrevendo no barramento da vida do lead.
 *
 * Roda fora do request (pg.Pool, não client do Supabase), mas a LINHA é montada
 * pela mesma `buildLeadActivityRow` que a API usa — a regra de lastro vive num
 * lugar só. E o roteamento contato→negócio é o `resolveActiveLeadForContact`:
 * quando o alvo é ambíguo ou inexistente, NÃO adivinha, registra
 * `agent.activity_unrouted` no event_log. Não-roteado é barulho auditável;
 * roteado errado move o card do cliente errado.
 */
export async function emitAgentActivityForContact(
  input: AgentActivityInput,
): Promise<AgentActivityResult> {
  const { pool, organizationId, contactId } = input;

  const { rows } = await pool.query<LeadCandidate>(
    `select l.id, l.organization_id, l.pipeline_id, l.status,
            l.last_activity_at, l.created_at
       from crm_leads l
      where l.organization_id = $1 and l.contact_id = $2`,
    [organizationId, contactId],
  );

  const { rows: defaults } = await pool.query<{ id: string }>(
    `select id from crm_pipelines
      where organization_id = $1 and is_default = true and is_archived = false
      limit 1`,
    [organizationId],
  );

  const alvo = resolveActiveLeadForContact(rows, { defaultPipelineId: defaults[0]?.id ?? null });

  if (!alvo.routed) {
    await pool.query(
      `insert into event_log (organization_id, event_type, entity_kind, entity_id, payload, metadata)
       values ($1, 'agent.activity_unrouted', 'contact', $2, $3, $4)`,
      [
        organizationId,
        contactId,
        JSON.stringify({
          reason: alvo.reason,
          candidate_lead_ids: alvo.candidateIds,
          activity_type: input.type,
        }),
        JSON.stringify({ source_module: input.sourceModule, source_id: input.sourceId ?? null }),
      ],
    );
    return { routed: false, reason: alvo.reason };
  }

  const row = buildLeadActivityRow({
    organizationId,
    leadId: alvo.leadId,
    contactId,
    type: input.type,
    sourceModule: input.sourceModule,
    sourceId: input.sourceId ?? null,
    actor: input.usuarioId
      ? // Pessoa antes de máquina: quem tem nome assina.
        { type: "user", id: input.usuarioId }
      : input.agentId
        ? // `agent_id` explícito: é ele que vai para a coluna com FK. Ver o ⚠️ de
          // `Actor` em lib/api/handlers/types.ts.
          { type: "ai_agent", id: input.agentId, agent_id: input.agentId, role: "agent" }
        : { type: "webhook_source", id: input.sourceModule },
    reason: input.reason,
    evidence: input.evidence ?? null,
    payload: input.payload ?? {},
  });

  await pool.query(
    `insert into crm_lead_activities
       (organization_id, lead_id, contact_id, type, source_module, source_id,
        actor_kind, actor_agent_id, performed_by_user_id, reason, evidence, payload)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      row.organization_id,
      row.lead_id,
      row.contact_id,
      row.type,
      row.source_module,
      row.source_id,
      row.actor_kind,
      row.actor_agent_id,
      row.performed_by_user_id,
      row.reason,
      row.evidence ? JSON.stringify(row.evidence) : null,
      JSON.stringify(row.payload),
    ],
  );

  return { routed: true, leadId: alvo.leadId };
}
