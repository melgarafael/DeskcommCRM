import { beginServiceAtOrigin, assertServiceBoundarySupabase } from "@/lib/atendimento/origem";
/**
 * MCP special tool — crm_request_human_handoff v2 (Spec 11 §3.3 + G6-01).
 *
 * Side effects (todos via `triggerHandoff` orchestrator + assignment best-effort):
 *   - conversations.status='pending', bot_silenced_until='infinity'
 *   - crm_lead_activities INSERT (type='handoff_triggered') quando há lead vinculado
 *   - event_log INSERT event_type='ai.handoff_triggered'
 *   - Realtime broadcast `org:<org>:queue` event=handoff_pending
 *   - api_audit_log action='ai.handoff_triggered' (+ mcp.tool_called no server core)
 *
 * v2 (G6-01 / INB-12): a ESCOLHA do destino usa o roteamento G5 — UM algoritmo:
 *   - `target_user_id` opcional: se passado E elegível agora (disponível ∧ horário
 *     ∧ folga), atribui a ele;
 *   - senão, rodízio real `selectRoundRobin` sobre os elegíveis (mesma lógica do
 *     worker de roteamento — o antigo pickRoundRobinAssignee random foi removido);
 *   - sem ninguém elegível → fila (fallback), retornando a posição.
 *   Retorno estruturado: { assigned_to } OU { queued: true, position }.
 *   Efeitos auditados (assignment event reason='handoff') preservados nos dois casos.
 */
import { z } from "zod";

import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";
import { loadEligibleAttendants } from "@/lib/routing/eligibles";
import { selectRoundRobin } from "@/lib/routing/decide";
import { getQueuePosition } from "@/lib/routing/queue";
import { logger } from "@/lib/logger";
import type { McpToolDefinition } from "../types";

const inputShape = {
  conversation_id: z.string().uuid(),
  reason: z.string().min(1).max(500).default("requested_human"),
  urgency: z.enum(["low", "normal", "high"]).default("normal"),
  /** Atendente alvo opcional: só atribui se elegível agora; senão cai no rodízio G5. */
  target_user_id: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
};

export const crmRequestHumanHandoff: McpToolDefinition<typeof inputShape> = {
  name: "crm_request_human_handoff",
  description:
    "Aciona handoff bot→humano. Marca a conversa como pending, silencia o bot e escolhe o " +
    "destino pelo roteamento G5: atende o target_user_id se elegível agora, senão rodízio " +
    "entre os disponíveis; sem ninguém elegível vai para a fila. Registra activity + " +
    "event_log + audit. Retorna assigned_to OU queued+position. Use quando o cliente pedir " +
    "atendente humano ou o agente identificar limite da automação.",
  inputSchema: inputShape,
  category: "handoff",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    // Conversation must belong to org (defense in depth — service role bypassa RLS).
    const { data: conv, error: convErr } = await ctx.supabase
      .from("conversations")
      .select("id, organization_id, contact_id, channel_session_id, last_inbound_at")
      .eq("organization_id", ctx.organizationId)
      .eq("id", input.conversation_id)
      .maybeSingle();
    if (convErr) throw new Error(convErr.message);
    if (!conv || conv.organization_id !== ctx.organizationId) {
      throw new Error("conversation_not_found");
    }

    const boundary = conv.contact_id ? await beginServiceAtOrigin(ctx.supabase, ctx.organizationId, conv.contact_id, conv.channel_session_id) : undefined;
    if (boundary && boundary.conversation_id !== input.conversation_id) throw new Error("service_scope_mismatch");

    // Try to find a lead linked to this contact (best effort for activity insert).
    let leadId: string | null = null;
    if (conv.contact_id) {
      const { data: leadRow } = await ctx.supabase
        .from("crm_leads")
        .select("id")
        .eq("organization_id", ctx.organizationId)
        .eq("contact_id", conv.contact_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      leadId = leadRow?.id ?? null;
    }

    const result = await triggerHandoff({
      serviceBoundary: boundary,
      conversationId: input.conversation_id,
      organizationId: ctx.organizationId,
      reason: "requested_human",
      leadId,
      metadata: {
        source: "ai_agent",
        urgency: input.urgency,
        original_reason: input.reason,
        ...(ctx.actor.type === "ai_agent" ? { run_id: ctx.actor.id } : {}),
        ...(input.metadata ?? {}),
      },
    });

    let assignedUserId: string | null = null;
    let queued = false;
    let position: number | null = null;

    if (result.triggered) {
      const now = new Date();
      // INB-12: mesmos elegíveis do worker de roteamento (G5) — um algoritmo só.
      const eligibles = await loadEligibleAttendants(ctx.supabase, ctx.organizationId, now, {
        kind: "conversation_channel", channelSessionId: conv.channel_session_id,
      });
      const picked =
        input.target_user_id && eligibles.some((e) => e.userId === input.target_user_id)
          ? input.target_user_id
          : selectRoundRobin(eligibles);

      if (picked) {
        // G3-02: reassignment auditado — UPDATE (kind ai→'user') + evento
        // reason='handoff' na MESMA transação (fn_conversation_assign, 0031/0032).
        if (boundary) await assertServiceBoundarySupabase(ctx.supabase, boundary);
        const { data: claimed, error: assignErr } = await ctx.supabase.rpc("fn_channel_routing_claim", {
          p_org: ctx.organizationId, p_conversation: input.conversation_id,
          p_channel: conv.channel_session_id, p_user: picked, p_reason: "handoff",
          p_schedule: eligibles.find((candidate) => candidate.userId === picked)?.scheduleSnapshot ?? {},
        });
        if (assignErr || claimed !== "assigned") {
          logger.warn("[mcp.handoff] assignment failed", {
            conversation_id: input.conversation_id,
            error: assignErr?.message ?? "0 rows (conversation not found)",
          });
        } else {
          assignedUserId = picked;
        }
      }

      if (!assignedUserId) {
        // CAS: não apaga o kind de um dono que venceu entre seleção e claim.
        const { data: queuedRows, error: kindErr } = await ctx.supabase
          .from("conversations").update({ assignee_kind: null })
          .eq("id", input.conversation_id).eq("organization_id", ctx.organizationId)
          .is("assigned_to_user_id", null).in("status", ["open", "pending", "ai_handling"])
          .select("id");
        if (kindErr) throw new Error(kindErr.message);
        if (!queuedRows?.length) {
          const { data: current, error } = await ctx.supabase.from("conversations")
            .select("assigned_to_user_id").eq("id", input.conversation_id)
            .eq("organization_id", ctx.organizationId).maybeSingle();
          if (error) throw new Error(error.message);
          assignedUserId = current?.assigned_to_user_id ?? null;
        } else {
          const { error } = await ctx.supabase.rpc("fn_request_channel_routing", {
            p_org: ctx.organizationId, p_conversation: input.conversation_id,
          });
          if (error) throw new Error(error.message);
        }
        queued = Boolean(queuedRows?.length);
        position = queued ? await getQueuePosition(
          ctx.supabase,
          ctx.organizationId,
          conv.last_inbound_at ?? null,
          now,
        ) : null;
      }
    }

    return {
      handoff_recorded: result.triggered,
      conversation_id: input.conversation_id,
      // Retorno estruturado v2: um destes dois lados é populado.
      assigned_to: assignedUserId,
      queued,
      position,
      // Compat com o contrato anterior (callers que liam assigned_to_user_id).
      assigned_to_user_id: assignedUserId,
      idempotent: !result.triggered && result.reason === "idempotent_5s",
      next_action:
        "Avise o cliente em tom acolhedor que um atendente humano vai assumir em instantes.",
    };
  },
};
