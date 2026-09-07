import { serviceForAutomation } from "@/lib/atendimento/origem-automacao";
/**
 * Ação `start_message_flow` — inscreve o contato do contexto num follow-up
 * publicado. Reusa enrollFollowupFlow (mesmo caminho do POST de enrollments).
 * organization_id vem da regra, nunca do body.
 *
 * Enroll não emite event_log; requestId `rule:{id}` fica no audit se houver
 * actor humano. Conflito de inscrição viva (23505) falha de forma explícita.
 */
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { enrollFollowupFlow } from "@/lib/followup/enroll";

const TYPE = "start_message_flow";

function contactIdFromCtx(ctx: ActionCtx): string | null {
  const contact = ctx.context.contact as { id?: string } | undefined;
  if (typeof contact?.id === "string" && contact.id) return contact.id;
  const lead = ctx.context.lead as { contact_id?: string | null } | undefined;
  if (typeof lead?.contact_id === "string" && lead.contact_id) return lead.contact_id;
  return null;
}

export async function executeStartMessageFlow(
  ctx: ActionCtx,
  config: Record<string, unknown>,
): Promise<ActionResultDetail> {
  const pointerId = typeof config.flow_pointer_id === "string" ? config.flow_pointer_id : null;
  if (!pointerId) {
    return { type: TYPE, status: "failed", error: "missing_config" };
  }

  const contactId = contactIdFromCtx(ctx);
  if (!contactId) {
    return { type: TYPE, status: "skipped", detail: { reason: "no_contact" } };
  }

  const result = await enrollFollowupFlow(ctx.admin, {
    resolveServiceBoundary: () => serviceForAutomation(ctx, contactId),
    organizationId: ctx.organizationId,
    pointerId,
    contactId,
    actorUserId: null,
    requestId: `rule:${ctx.ruleId}`,
  });

  if (!result.ok) {
    if (result.code === "conflict") {
      return {
        type: TYPE,
        status: "failed",
        error: "live_enrollment_exists",
        detail: { reason: "live_enrollment_exists" },
      };
    }
    if (result.code === "flow_not_active") {
      return { type: TYPE, status: "skipped", detail: { reason: "flow_not_active" } };
    }
    return { type: TYPE, status: "failed", error: result.message, detail: { code: result.code } };
  }

  return {
    type: TYPE,
    status: "success",
    detail: { enrollment_id: result.enrollment.id },
  };
}

registerAction({ type: TYPE, execute: executeStartMessageFlow });
