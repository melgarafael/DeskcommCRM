import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
import { assertServiceBoundarySupabase } from "@/lib/atendimento/origem";
import { beginServiceAtOrigin } from "@/lib/atendimento/origem";
/**
 * Inscrição de um contato num fluxo publicado.
 *
 * Extraído do POST /api/v1/ai/followups/enrollments para o mesmo caminho
 * servir a ação de webhook (service-role + organization_id da regra).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import {
  createSupabaseFollowupGateDb,
  resolveAgentForAutomaticTrigger,
} from "@/lib/followup/agent-followup-gate";
import { flowGraphSchema } from "@/lib/followup/graph-schema";

export const ENROLLMENT_LIST_COLUMNS =
  "id, pointer_id, version_id, contact_id, status, current_node_id, next_eval_at, outcome, started_at, completed_at, updated_at";

export type EnrollFollowupInput = {
  organizationId: string;
  resolveServiceBoundary?: () => Promise<ServiceBoundary>;
  pointerId: string;
  contactId: string;
  agentId?: string;
  actorUserId: string | null;
  requestId: string;
};

export type EnrollFollowupOk = { ok: true; enrollment: Record<string, unknown> };
export type EnrollFollowupErr = {
  ok: false;
  code: string;
  message: string;
  status: number;
};
export type EnrollFollowupResult = EnrollFollowupOk | EnrollFollowupErr;

export async function enrollFollowupFlow(
  supabase: SupabaseClient,
  input: EnrollFollowupInput,
): Promise<EnrollFollowupResult> {
  const { organizationId, pointerId, contactId, requestId } = input;

  const { data: pointer, error: pointerErr } = await supabase
    .from("followup_flow_pointers")
    .select("id, status, active_version_id")
    .eq("organization_id", organizationId)
    .eq("id", pointerId)
    .maybeSingle();
  if (pointerErr) return { ok: false, code: "internal_error", message: pointerErr.message, status: 500 };
  if (!pointer) return { ok: false, code: "not_found", message: "Fluxo não encontrado.", status: 404 };

  if (pointer.status !== "active" || !pointer.active_version_id) {
    return {
      ok: false,
      code: "flow_not_active",
      message: "Fluxo não está ativo (precisa estar publicado).",
      status: 422,
    };
  }

  const { data: contact, error: contactErr } = await supabase
    .from("contacts")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();
  if (contactErr) return { ok: false, code: "internal_error", message: contactErr.message, status: 500 };
  if (!contact) return { ok: false, code: "not_found", message: "Contato não encontrado.", status: 404 };

  const { data: version, error: versionErr } = await supabase
    .from("followup_flow_versions")
    .select("graph")
    .eq("organization_id", organizationId)
    .eq("id", pointer.active_version_id)
    .maybeSingle();
  if (versionErr) return { ok: false, code: "internal_error", message: versionErr.message, status: 500 };
  if (!version) {
    return { ok: false, code: "internal_error", message: "Version ativa do fluxo não encontrada.", status: 500 };
  }

  const graph = flowGraphSchema.parse(version.graph);
  const triggerNode = graph.nodes.find((n) => n.type === "trigger");
  if (!triggerNode) {
    return { ok: false, code: "internal_error", message: "Grafo publicado sem nó trigger.", status: 500 };
  }

  // Task 8.6: fixa qual agente arma este enrollment. Se o caller passou agentId,
  // valida que é um agente DA ORG (nunca confia no body pra tenancy). Senão,
  // resolve do próprio pointer (agentes publicados que o habilitam) — mesmo
  // pick determinístico do silence-sweep. Sem nenhum resolvível → null (ok).
  let agentId: string | null = null;
  if (input.agentId !== undefined) {
    const { data: agent, error: agentErr } = await supabase
      .from("ai_agents")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("id", input.agentId)
      .maybeSingle();
    if (agentErr) return { ok: false, code: "internal_error", message: agentErr.message, status: 500 };
    if (!agent) return { ok: false, code: "not_found", message: "Agente não encontrado.", status: 404 };
    agentId = input.agentId;
  } else {
    agentId = await resolveAgentForAutomaticTrigger(
      createSupabaseFollowupGateDb(supabase),
      organizationId,
      pointerId,
    );
  }

  const boundary = input.resolveServiceBoundary ? await input.resolveServiceBoundary() : await beginServiceAtOrigin(supabase, organizationId, contactId);
  if (input.resolveServiceBoundary) await assertServiceBoundarySupabase(supabase, boundary);
  const { data: created, error: insErr } = await supabase
    .from("followup_enrollments")
    .insert({
      organization_id: organizationId,
      pointer_id: pointerId,
      version_id: pointer.active_version_id,
      contact_id: contactId,
      current_node_id: triggerNode.id,
      status: "active",
      // next_eval_at omite: default now() do banco (migration 0147). new Date()
      // do processo fica 17–34 ms à frente e o claim `<= now()` pula o tick.
      agent_id: agentId,
      service_boundary: boundary,
      conversation_id: boundary.conversation_id,
    })
    .select(ENROLLMENT_LIST_COLUMNS)
    .single();

  if (insErr || !created) {
    if (insErr?.code === "23505") {
      return {
        ok: false,
        code: "conflict",
        message: "Este contato já está em um follow-up ativo (1 por lead na organização).",
        status: 409,
      };
    }
    return {
      ok: false,
      code: "internal_error",
      message: insErr?.message ?? "followup_enrollment_insert_failed",
      status: 500,
    };
  }

  if (input.actorUserId) {
    void audit({
      action: "followup_enrollment.created",
      actorUserId: input.actorUserId,
      organizationId,
      resourceType: "followup_enrollment",
      resourceId: created.id,
      requestId,
      metadata: {
        pointer_id: pointerId,
        contact_id: contactId,
        version_id: pointer.active_version_id,
        agent_id: agentId,
      },
    });
  }

  return { ok: true, enrollment: created as Record<string, unknown> };
}
