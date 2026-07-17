/**
 * Ação `create_or_move_lead` — reusa os handlers core de /api/v1/leads
 * (mesmo caminho que REST/MCP) em vez de duplicar a lógica de criação/move.
 *
 * Actor = `webhook_source` com id = ruleId (ator automático; audit registra
 * actor_type=webhook_source). requestId = `rule:${ruleId}` — os handlers
 * propagam esse valor pro metadata.request_id dos eventos que emitem, e é
 * esse prefixo "rule:" que o engine (Task 8) usa pra não reprocessar os
 * eventos derivados (anti-loop profundidade 1: regra→ação→handler→evento).
 */
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { createLeadHandler, moveLeadHandler } from "@/app/api/v1/leads/_handler";

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const pipelineId = typeof config.pipeline_id === "string" ? config.pipeline_id : null;
  const stageId = typeof config.stage_id === "string" ? config.stage_id : null;
  if (!pipelineId || !stageId) {
    return { type: "create_or_move_lead", status: "failed", error: "missing_config" };
  }

  const handlerCtx: HandlerCtx = {
    organization_id: ctx.organizationId,
    actor: { type: "webhook_source", id: ctx.ruleId },
    requestId: `rule:${ctx.ruleId}`,
  };
  const lead = ctx.context.lead as { id: string; pipeline_id: string } | undefined;
  const contact = ctx.context.contact as
    | { id: string; display_name?: string | null; phone_number?: string | null }
    | undefined;

  try {
    if (lead) {
      if (lead.pipeline_id !== pipelineId) {
        return { type: "create_or_move_lead", status: "failed", error: "cross_pipeline_move_not_allowed" };
      }
      await moveLeadHandler(ctx.admin, handlerCtx, lead.id, { to_stage_id: stageId });
      return { type: "create_or_move_lead", status: "success", detail: { moved: lead.id } };
    }
    if (contact) {
      const created = await createLeadHandler(ctx.admin, handlerCtx, {
        pipeline_id: pipelineId,
        stage_id: stageId,
        title: contact.display_name ?? contact.phone_number ?? "Lead da automação",
        contact_id: contact.id,
        source: "automation",
      } as Parameters<typeof createLeadHandler>[2]);
      return { type: "create_or_move_lead", status: "success", detail: { created: String(created.id) } };
    }
    return { type: "create_or_move_lead", status: "skipped", detail: { reason: "no_lead_or_contact" } };
  } catch (err) {
    return {
      type: "create_or_move_lead",
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

registerAction({ type: "create_or_move_lead", execute });
