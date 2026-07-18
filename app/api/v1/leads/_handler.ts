/**
 * Core handlers para /api/v1/leads.
 *
 * REST cobre: createLeadHandler (POST), updateLeadHandler (PATCH).
 * MCP usa: listLeadsHandler, getLeadHandler além dos acima (S-13.04).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { Actor, HandlerCtx } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import type { CreateLeadInput, UpdateLeadInput } from "@/lib/schemas";

type SB = SupabaseClient;

const LEAD_COLS = "*";

function actorAuditPayload(actor: Actor): {
  actorUserId: string | null;
  metadataActor: Record<string, unknown>;
} {
  if (actor.type === "user") {
    return { actorUserId: actor.id, metadataActor: { actor_type: "user" } };
  }
  if (actor.type === "webhook_source") {
    return {
      actorUserId: null,
      metadataActor: { actor_type: "webhook_source", actor_id: actor.id },
    };
  }
  return {
    actorUserId: null,
    metadataActor: {
      actor_type: "ai_agent",
      actor_id: actor.id,
      ...(actor.api_token_id ? { actor_api_token_id: actor.api_token_id } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// list (MCP-only por enquanto; sem GET REST nesta wave)
// ---------------------------------------------------------------------------

export interface ListLeadsQuery {
  pipeline_id?: string;
  stage_id?: string;
  status?: "open" | "won" | "lost";
  owner_user_id?: string;
  limit?: number;
  cursor?: string | null;
}

export interface ListLeadsResult {
  leads: Array<Record<string, unknown>>;
  cursor: string | null;
  has_more: boolean;
}

interface LeadCursor {
  created_at: string;
  id: string;
}
function encLeadCursor(p: LeadCursor): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}
function decLeadCursor(raw: string): LeadCursor | null {
  try {
    const p = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as LeadCursor;
    if (typeof p.id !== "string" || typeof p.created_at !== "string") return null;
    return p;
  } catch {
    return null;
  }
}

export async function listLeadsHandler(
  supabase: SB,
  ctx: HandlerCtx,
  q: ListLeadsQuery,
): Promise<ListLeadsResult> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
  let query = supabase
    .from("crm_leads")
    .select(LEAD_COLS)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (q.pipeline_id) query = query.eq("pipeline_id", q.pipeline_id);
  if (q.stage_id) query = query.eq("stage_id", q.stage_id);
  if (q.status) query = query.eq("status", q.status);
  if (q.owner_user_id) query = query.eq("owner_user_id", q.owner_user_id);

  if (q.cursor) {
    const c = decLeadCursor(q.cursor);
    if (!c) {
      throw new ApiError(400, "invalid_cursor", undefined, ctx.requestId, "Cursor inválido.");
    }
    query = query.or(
      `created_at.lt.${c.created_at},and(created_at.eq.${c.created_at},id.lt.${c.id})`,
    );
  }

  const { data, error } = await query;
  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  }
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const cursor =
    hasMore && last
      ? encLeadCursor({ created_at: String(last.created_at), id: String(last.id) })
      : null;
  return { leads: page, cursor, has_more: hasMore };
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

export async function getLeadHandler(
  supabase: SB,
  ctx: HandlerCtx,
  leadId: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase
    .from("crm_leads")
    .select(LEAD_COLS)
    .eq("id", leadId)
    .maybeSingle();
  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  }
  if (!data) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Lead não encontrado.");
  }
  return data as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export async function createLeadHandler(
  supabase: SB,
  ctx: HandlerCtx,
  input: CreateLeadInput & {
    custom_fields?: Record<string, unknown>;
    source_metadata?: Record<string, unknown>;
    /** Interno (webhook inbound) — idempotência via uniq_crm_leads_org_source_external. */
    external_id?: string;
  },
): Promise<Record<string, unknown>> {
  // Validate stage belongs to pipeline within active org.
  const { data: stage, error: stageErr } = await supabase
    .from("crm_stages")
    .select("id, pipeline_id, organization_id")
    .eq("id", input.stage_id)
    .maybeSingle();

  if (stageErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, stageErr.message);
  }
  if (!stage || stage.organization_id !== ctx.organization_id) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Stage não encontrado.");
  }
  if (stage.pipeline_id !== input.pipeline_id) {
    throw new ApiError(
      422,
      "stage_pipeline_mismatch",
      undefined,
      ctx.requestId,
      "Stage não pertence ao pipeline informado.",
    );
  }

  // next position_in_stage = MAX + 1000.
  const { data: maxRow, error: maxErr } = await supabase
    .from("crm_leads")
    .select("position_in_stage")
    .eq("stage_id", input.stage_id)
    .order("position_in_stage", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (maxErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, maxErr.message);
  }
  const nextPos = maxRow?.position_in_stage ? Number(maxRow.position_in_stage) + 1000 : 1000;

  const { data: lead, error: insErr } = await supabase
    .from("crm_leads")
    .insert({
      organization_id: ctx.organization_id,
      pipeline_id: input.pipeline_id,
      stage_id: input.stage_id,
      title: input.title,
      description: input.description ?? null,
      contact_id: input.contact_id ?? null,
      value_cents: input.value_cents ?? null,
      currency: input.currency ?? "BRL",
      owner_user_id: input.owner_user_id ?? null,
      expected_close_date: input.expected_close_date ?? null,
      tags: input.tags ?? [],
      source: input.source,
      source_metadata: input.source_metadata ?? {},
      external_id: input.external_id ?? null,
      custom_fields: input.custom_fields ?? {},
      status: "open",
      position_in_stage: nextPos,
      created_by_user_id: ctx.actor.type === "user" ? ctx.actor.id : null,
    })
    .select(LEAD_COLS)
    .single();

  if (insErr || !lead) {
    throw new ApiError(
      500,
      "internal_error",
      undefined,
      ctx.requestId,
      insErr?.message ?? "Falha ao criar lead.",
    );
  }

  const a = actorAuditPayload(ctx.actor);
  await supabase
    .rpc("emit_event", {
      p_event_type: "lead.created",
      p_entity_kind: "crm_lead",
      p_entity_id: (lead as { id: string }).id,
      p_payload: {
        pipeline_id: (lead as { pipeline_id: string }).pipeline_id,
        stage_id: (lead as { stage_id: string }).stage_id,
        title: (lead as { title: string }).title,
      },
      p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
      p_organization_id: ctx.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[lead.create] emit_event failed", error.message);
    });

  await audit({
    action: "lead.created",
    actorUserId: a.actorUserId,
    organizationId: ctx.organization_id,
    resourceType: "crm_lead",
    resourceId: (lead as { id: string }).id,
    requestId: ctx.requestId,
    metadata: {
      ...a.metadataActor,
      pipeline_id: (lead as { pipeline_id: string }).pipeline_id,
      stage_id: (lead as { stage_id: string }).stage_id,
      title: (lead as { title: string }).title,
    },
  });

  return lead as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

export async function updateLeadHandler(
  supabase: SB,
  ctx: HandlerCtx,
  leadId: string,
  input: UpdateLeadInput,
): Promise<Record<string, unknown>> {
  const { data: existing, error: selErr } = await supabase
    .from("crm_leads")
    .select("id, organization_id, tags")
    .eq("id", leadId)
    .maybeSingle();

  if (selErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, selErr.message);
  }
  if (!existing) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Lead não encontrado.");
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.contact_id !== undefined) patch.contact_id = input.contact_id;
  if (input.value_cents !== undefined) patch.value_cents = input.value_cents;
  if (input.currency !== undefined) patch.currency = input.currency;
  if (input.owner_user_id !== undefined) {
    patch.owner_user_id = input.owner_user_id;
    if (input.owner_user_id !== null) {
      patch.assigned_at = new Date().toISOString();
    }
  }
  if (input.expected_close_date !== undefined) {
    patch.expected_close_date = input.expected_close_date;
  }
  if (input.tags !== undefined) patch.tags = input.tags;

  const { data: updated, error: updErr } = await supabase
    .from("crm_leads")
    .update(patch)
    .eq("id", leadId)
    .select(LEAD_COLS)
    .maybeSingle();

  if (updErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, updErr.message);
  }
  if (!updated) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Lead não encontrado.");
  }

  const a = actorAuditPayload(ctx.actor);
  const fields = Object.keys(input);

  await supabase
    .rpc("emit_event", {
      p_event_type: "lead.updated",
      p_entity_kind: "crm_lead",
      p_entity_id: leadId,
      p_payload: { fields },
      p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
      p_organization_id: existing.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[lead.update] emit_event failed", error.message);
    });

  if (input.tags !== undefined) {
    const prevTags: string[] = (existing as { tags?: string[] }).tags ?? [];
    const addedTags = input.tags.filter((t) => !prevTags.includes(t));
    if (addedTags.length) {
      await supabase
        .rpc("emit_event", {
          p_event_type: "lead.tag_added",
          p_entity_kind: "crm_lead",
          p_entity_id: leadId,
          p_payload: { added_tags: addedTags, tags: input.tags },
          p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
          p_organization_id: existing.organization_id,
        })
        .then(({ error }) => {
          if (error) console.error("[lead.update] emit_event failed", error.message);
        });
    }
  }

  await audit({
    action: "lead.updated",
    actorUserId: a.actorUserId,
    organizationId: existing.organization_id,
    resourceType: "crm_lead",
    resourceId: leadId,
    requestId: ctx.requestId,
    metadata: { ...a.metadataActor, fields },
  });

  return updated as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// move (within same pipeline) — extraido para reuso pelo MCP (S-13.04)
// ---------------------------------------------------------------------------

export interface MoveLeadAdminInput {
  to_stage_id: string;
  /** Optional fractional position. If omitted, append at end (max + 1000). */
  position_in_stage?: number;
  reason?: string;
}

export async function moveLeadHandler(
  supabase: SB,
  ctx: HandlerCtx,
  leadId: string,
  input: MoveLeadAdminInput,
): Promise<Record<string, unknown>> {
  const { data: lead, error: selErr } = await supabase
    .from("crm_leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle();

  if (selErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, selErr.message);
  }
  if (!lead || lead.organization_id !== ctx.organization_id) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Lead não encontrado.");
  }

  const { data: stage, error: stageErr } = await supabase
    .from("crm_stages")
    .select("id, pipeline_id, organization_id")
    .eq("id", input.to_stage_id)
    .maybeSingle();
  if (stageErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, stageErr.message);
  }
  if (!stage || stage.organization_id !== ctx.organization_id) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Stage não encontrado.");
  }
  if (stage.pipeline_id !== lead.pipeline_id) {
    throw new ApiError(
      422,
      "pipeline_immutable_use_clone",
      undefined,
      ctx.requestId,
      "Move cross-pipeline não é permitido.",
    );
  }

  let position = input.position_in_stage;
  if (position === undefined) {
    const { data: maxRow } = await supabase
      .from("crm_leads")
      .select("position_in_stage")
      .eq("stage_id", input.to_stage_id)
      .order("position_in_stage", { ascending: false })
      .limit(1)
      .maybeSingle();
    position = maxRow?.position_in_stage ? Number(maxRow.position_in_stage) + 1000 : 1000;
  }

  const nowIso = new Date().toISOString();
  const { data: updated, error: updErr } = await supabase
    .from("crm_leads")
    .update({
      stage_id: input.to_stage_id,
      position_in_stage: position,
      updated_at: nowIso,
    })
    .eq("id", leadId)
    .eq("updated_at", lead.updated_at)
    .select("*")
    .maybeSingle();

  if (updErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, updErr.message);
  }
  if (!updated) {
    throw new ApiError(
      409,
      "lead_stage_changed_concurrent",
      undefined,
      ctx.requestId,
      "Lead foi modificado concorrentemente.",
    );
  }

  const { data: fresh } = await supabase
    .from("crm_leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle();
  const finalLead = (fresh ?? updated) as Record<string, unknown>;

  const a = actorAuditPayload(ctx.actor);
  await supabase
    .rpc("emit_event", {
      p_event_type: "lead.stage_changed",
      p_entity_kind: "crm_lead",
      p_entity_id: leadId,
      p_payload: {
        pipeline_id: lead.pipeline_id,
        from_stage_id: lead.stage_id,
        to_stage_id: input.to_stage_id,
        position_in_stage: position,
        status: (finalLead as { status: string }).status,
      },
      p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
      p_organization_id: lead.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[lead.move] emit_event failed", error.message);
    });

  await audit({
    action: "lead.moved",
    actorUserId: a.actorUserId,
    organizationId: lead.organization_id,
    resourceType: "crm_lead",
    resourceId: leadId,
    requestId: ctx.requestId,
    metadata: {
      ...a.metadataActor,
      from_stage_id: lead.stage_id,
      to_stage_id: input.to_stage_id,
      position_in_stage: position,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });

  return finalLead;
}
