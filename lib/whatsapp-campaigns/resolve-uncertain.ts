/**
 * Resolução explícita de send_uncertain — nunca requeue genérico.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";

type SB = SupabaseClient;

function err(ctx: HandlerCtx, status: number, code: string, message: string): never {
  throw new ApiError(status, code, undefined, ctx.requestId, message);
}

export const resolveUncertainSchema = z.object({
  resolution: z.enum(["assume_sent", "retry_anyway"]),
  note: z.string().max(2000).optional().nullable(),
});

const OPEN_STATUSES = [
  "pending",
  "scheduled",
  "processing",
  "send_uncertain",
] as const;

export async function resolveUncertainRecipientHandler(
  supabase: SB,
  ctx: HandlerCtx,
  userId: string,
  campaignId: string,
  recipientId: string,
  raw: unknown,
) {
  const body = resolveUncertainSchema.parse(raw);

  const { data: recipient, error: recErr } = await supabase
    .from("whatsapp_campaign_recipients")
    .select("*")
    .eq("organization_id", ctx.organization_id)
    .eq("campaign_id", campaignId)
    .eq("id", recipientId)
    .maybeSingle();
  if (recErr) err(ctx, 500, "internal_error", recErr.message);
  if (!recipient) err(ctx, 404, "not_found", "Destinatário não encontrado.");
  if (recipient.status !== "send_uncertain") {
    err(
      ctx,
      422,
      "validation_failed",
      "Só destinatários com status send_uncertain podem ser resolvidos.",
    );
  }

  const previousOutbound = recipient.outbound_message_id as string | null;
  const previousMessageId = recipient.message_id as string | null;
  const attemptNumber = Number(recipient.attempt_count ?? 0);

  if (body.resolution === "assume_sent") {
    // Não inventa external_message_id — assumed_sent ≠ confirmação do provider.
    const { data: updated, error } = await supabase
      .from("whatsapp_campaign_recipients")
      .update({
        status: "assumed_sent",
        uncertainty_resolution: "assume_sent",
        uncertainty_resolved_at: new Date().toISOString(),
        uncertainty_resolved_by: userId,
        uncertainty_resolution_note: body.note ?? null,
        claimed_at: null,
        claimed_by: null,
      })
      .eq("organization_id", ctx.organization_id)
      .eq("id", recipientId)
      .eq("status", "send_uncertain")
      .select("*")
      .maybeSingle();
    if (error) err(ctx, 500, "internal_error", error.message);
    if (!updated) err(ctx, 409, "conflict", "Destinatário não está mais send_uncertain.");

    await insertResolution(supabase, {
      organizationId: ctx.organization_id,
      campaignId,
      recipientId,
      attemptNumber,
      resolution: "assume_sent",
      userId,
      note: body.note,
      previousOutbound,
      previousMessageId,
      newOutbound: null,
      metadata: { risk: "operator_assumed_without_provider_ack" },
    });

    await audit({
      organizationId: ctx.organization_id,
      actorUserId: userId,
      action: "whatsapp_campaigns.uncertain_assumed_sent",
      resourceType: "whatsapp_campaign_recipients",
      resourceId: recipientId,
      requestId: ctx.requestId,
      metadata: { campaign_id: campaignId, note: body.note ?? null },
    });

    await maybeCompleteCampaignViaClient(supabase, ctx.organization_id, campaignId);
    return updated;
  }

  // retry_anyway — operador aceita risco de duplicidade
  const newOutbound = randomUUID();
  const { data: updated, error } = await supabase
    .from("whatsapp_campaign_recipients")
    .update({
      status: "pending",
      next_attempt_at: new Date().toISOString(),
      outbound_message_id: newOutbound,
      uncertainty_resolution: "retry_anyway",
      uncertainty_resolved_at: new Date().toISOString(),
      uncertainty_resolved_by: userId,
      uncertainty_resolution_note: body.note ?? null,
      claimed_at: null,
      claimed_by: null,
      last_error: null,
    })
    .eq("organization_id", ctx.organization_id)
    .eq("id", recipientId)
    .eq("status", "send_uncertain")
    .select("*")
    .maybeSingle();
  if (error) err(ctx, 500, "internal_error", error.message);
  if (!updated) err(ctx, 409, "conflict", "Destinatário não está mais send_uncertain.");

  await insertResolution(supabase, {
    organizationId: ctx.organization_id,
    campaignId,
    recipientId,
    attemptNumber,
    resolution: "retry_anyway",
    userId,
    note: body.note,
    previousOutbound,
    previousMessageId,
    newOutbound,
    metadata: { risk: "operator_accepted_duplicate_risk" },
  });

  // Tentativa de auditoria distinta (não sobrescreve attempts anteriores)
  await supabase.from("whatsapp_campaign_attempts").insert({
    organization_id: ctx.organization_id,
    campaign_id: campaignId,
    recipient_id: recipientId,
    attempt_number: attemptNumber + 1000,
    channel_session_id: recipient.channel_session_id,
    status: "retry",
    finished_at: new Date().toISOString(),
    error_code: "retry_anyway",
    error_message: "Operador solicitou reenvio deliberado após send_uncertain",
    metadata: {
      resolution: "retry_anyway",
      previous_outbound_message_id: previousOutbound,
      new_outbound_message_id: newOutbound,
    },
  });

  await audit({
    organizationId: ctx.organization_id,
    actorUserId: userId,
    action: "whatsapp_campaigns.uncertain_retry_anyway",
    resourceType: "whatsapp_campaign_recipients",
    resourceId: recipientId,
    requestId: ctx.requestId,
    metadata: {
      campaign_id: campaignId,
      previous_outbound_message_id: previousOutbound,
      new_outbound_message_id: newOutbound,
      note: body.note ?? null,
    },
  });

  return updated;
}

async function insertResolution(
  supabase: SB,
  opts: {
    organizationId: string;
    campaignId: string;
    recipientId: string;
    attemptNumber: number;
    resolution: "assume_sent" | "retry_anyway";
    userId: string;
    note?: string | null;
    previousOutbound: string | null;
    previousMessageId: string | null;
    newOutbound: string | null;
    metadata: Record<string, unknown>;
  },
) {
  await supabase.from("whatsapp_campaign_uncertainty_resolutions").insert({
    organization_id: opts.organizationId,
    campaign_id: opts.campaignId,
    recipient_id: opts.recipientId,
    attempt_number: opts.attemptNumber,
    resolution: opts.resolution,
    resolved_by: opts.userId,
    note: opts.note ?? null,
    previous_outbound_message_id: opts.previousOutbound,
    new_outbound_message_id: opts.newOutbound,
    previous_message_id: opts.previousMessageId,
    metadata: opts.metadata,
  });
}

/** Completion sem pool: mesma regra do worker (EXISTS aberto). */
export async function maybeCompleteCampaignViaClient(
  supabase: SB,
  organizationId: string,
  campaignId: string,
): Promise<boolean> {
  const { data: openRows } = await supabase
    .from("whatsapp_campaign_recipients")
    .select("status, attempt_count, max_attempts")
    .eq("organization_id", organizationId)
    .eq("campaign_id", campaignId)
    .in("status", [...OPEN_STATUSES, "failed"]);

  const hasOpen = (openRows ?? []).some((r) => {
    if (OPEN_STATUSES.includes(r.status as (typeof OPEN_STATUSES)[number])) return true;
    if (r.status === "failed" && Number(r.attempt_count) < Number(r.max_attempts)) return true;
    return false;
  });

  if (hasOpen) return false;

  const { data } = await supabase
    .from("whatsapp_campaigns")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("id", campaignId)
    .eq("status", "running")
    .select("id")
    .maybeSingle();
  return Boolean(data);
}
