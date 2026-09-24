/**
 * Handlers HTTP/API para whatsapp_campaigns — Zod + org + audit.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { materializeCampaignAudience } from "@/lib/whatsapp-campaigns/materialize";
import {
  audienceSelectionSchema,
  campaignCreateSchema,
  campaignPatchSchema,
  resolveSessionIds,
} from "@/lib/whatsapp-campaigns/schemas";
import {
  firstNameFrom,
  renderCampaignTemplate,
  validateCampaignTemplate,
} from "@/lib/whatsapp-campaigns/template";
import { nextSendAtIso } from "@/lib/whatsapp-campaigns/pacing";

type SB = SupabaseClient;

function err(ctx: HandlerCtx, status: number, code: string, message: string): never {
  throw new ApiError(status, code, undefined, ctx.requestId, message);
}

async function assertSessionInOrg(
  supabase: SB,
  ctx: HandlerCtx,
  sessionId: string,
): Promise<{ id: string; status: string }> {
  const { data } = await supabase
    .from("channel_sessions")
    .select("id, organization_id, status")
    .eq("id", sessionId)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();
  if (!data) err(ctx, 404, "not_found", "Conexão WhatsApp não encontrada.");
  return data;
}

async function assertSessionWorking(
  supabase: SB,
  ctx: HandlerCtx,
  sessionId: string,
): Promise<void> {
  const data = await assertSessionInOrg(supabase, ctx, sessionId);
  if (data.status !== "WORKING") {
    err(ctx, 422, "validation_failed", "A conexão WhatsApp precisa estar WORKING.");
  }
}

async function assertAnySessionWorking(
  supabase: SB,
  ctx: HandlerCtx,
  campaignId: string,
): Promise<void> {
  const { data: rows } = await supabase
    .from("whatsapp_campaign_sessions")
    .select("channel_session_id, enabled")
    .eq("organization_id", ctx.organization_id)
    .eq("campaign_id", campaignId)
    .eq("enabled", true);
  const ids = (rows ?? []).map((r) => r.channel_session_id as string);
  if (ids.length === 0) {
    err(ctx, 422, "validation_failed", "Campanha sem conexão WhatsApp habilitada.");
  }
  const { data: sessions } = await supabase
    .from("channel_sessions")
    .select("id, status")
    .eq("organization_id", ctx.organization_id)
    .in("id", ids);
  if (!(sessions ?? []).some((s) => s.status === "WORKING")) {
    err(
      ctx,
      422,
      "validation_failed",
      "Nenhuma conexão WhatsApp da campanha está WORKING.",
    );
  }
}

async function syncCampaignSessions(
  supabase: SB,
  ctx: HandlerCtx,
  campaignId: string,
  sessionIds: string[],
): Promise<void> {
  for (const sid of sessionIds) {
    await assertSessionInOrg(supabase, ctx, sid);
  }
  const unique = [...new Set(sessionIds)];
  const { data: existing } = await supabase
    .from("whatsapp_campaign_sessions")
    .select("id, channel_session_id")
    .eq("organization_id", ctx.organization_id)
    .eq("campaign_id", campaignId);
  const have = new Set((existing ?? []).map((r) => r.channel_session_id as string));
  for (const sid of unique) {
    if (have.has(sid)) {
      await supabase
        .from("whatsapp_campaign_sessions")
        .update({ enabled: true })
        .eq("organization_id", ctx.organization_id)
        .eq("campaign_id", campaignId)
        .eq("channel_session_id", sid);
    } else {
      const { error } = await supabase.from("whatsapp_campaign_sessions").insert({
        organization_id: ctx.organization_id,
        campaign_id: campaignId,
        channel_session_id: sid,
        enabled: true,
      });
      if (error) err(ctx, 500, "internal_error", error.message);
    }
  }
  // Desabilita sessões removidas da seleção (não apaga histórico)
  for (const row of existing ?? []) {
    if (!unique.includes(row.channel_session_id as string)) {
      await supabase
        .from("whatsapp_campaign_sessions")
        .update({ enabled: false })
        .eq("organization_id", ctx.organization_id)
        .eq("id", row.id);
    }
  }
}

const RECIPIENT_STATUSES = [
  "pending",
  "scheduled",
  "processing",
  "sent",
  "delivered",
  "read",
  "replied",
  "failed",
  "skipped",
  "cancelled",
  "send_uncertain",
  "assumed_sent",
] as const;

export async function listCampaignsHandler(supabase: SB, ctx: HandlerCtx) {
  const { data, error } = await supabase
    .from("whatsapp_campaigns")
    .select(
      "id, name, status, channel_session_id, min_interval_seconds, max_interval_seconds, scheduled_at, started_at, completed_at, created_at, updated_at",
    )
    .eq("organization_id", ctx.organization_id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) err(ctx, 500, "internal_error", error.message);
  const campaigns = data ?? [];
  if (campaigns.length === 0) return [];

  const ids = campaigns.map((c) => c.id);
  const { data: countRows, error: countErr } = await supabase.rpc(
    "fn_whatsapp_campaign_status_counts",
    {
      p_organization_id: ctx.organization_id,
      p_campaign_ids: ids,
    },
  );
  if (countErr) err(ctx, 500, "internal_error", countErr.message);

  const byCampaign = new Map<string, Record<string, number>>();
  for (const row of countRows ?? []) {
    const cid = row.campaign_id as string;
    const bag = byCampaign.get(cid) ?? {};
    bag[row.status as string] = Number(row.n);
    byCampaign.set(cid, bag);
  }

  return campaigns.map((c) => {
    const counts = byCampaign.get(c.id) ?? {};
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return { ...c, stats: { total, counts } };
  });
}

export async function getCampaignHandler(supabase: SB, ctx: HandlerCtx, id: string) {
  const { data, error } = await supabase
    .from("whatsapp_campaigns")
    .select("*")
    .eq("organization_id", ctx.organization_id)
    .eq("id", id)
    .maybeSingle();
  if (error) err(ctx, 500, "internal_error", error.message);
  if (!data) err(ctx, 404, "not_found", "Campanha não encontrada.");

  const { data: sessions } = await supabase
    .from("whatsapp_campaign_sessions")
    .select(
      "id, channel_session_id, enabled, weight, next_send_at, created_at, channel_sessions(id, display_name, phone_number, status)",
    )
    .eq("organization_id", ctx.organization_id)
    .eq("campaign_id", id)
    .order("created_at", { ascending: true });

  return { ...data, sessions: sessions ?? [] };
}

export async function createCampaignHandler(
  supabase: SB,
  ctx: HandlerCtx,
  userId: string,
  raw: unknown,
) {
  const body = campaignCreateSchema.parse(raw);
  const tpl = validateCampaignTemplate(body.message_text);
  if (!tpl.ok) {
    err(ctx, 422, "validation_failed", `Variáveis inválidas: ${tpl.unknown.join(", ")}`);
  }
  const sessionIds = resolveSessionIds(body);
  for (const sid of sessionIds) {
    await assertSessionInOrg(supabase, ctx, sid);
  }
  const primary = sessionIds[0]!;

  const { data, error } = await supabase
    .from("whatsapp_campaigns")
    .insert({
      organization_id: ctx.organization_id,
      name: body.name,
      description: body.description ?? null,
      message_text: body.message_text,
      channel_session_id: primary,
      reply_stop_mode: body.reply_stop_mode,
      create_lead_on_reply: body.create_lead_on_reply,
      min_interval_seconds: body.min_interval_seconds,
      max_interval_seconds: body.max_interval_seconds,
      send_window_start: body.send_window_start ?? null,
      send_window_end: body.send_window_end ?? null,
      timezone: body.timezone,
      daily_limit: body.daily_limit ?? null,
      scheduled_at: body.scheduled_at ?? null,
      status: body.scheduled_at ? "scheduled" : "draft",
      created_by: userId,
    })
    .select("*")
    .single();
  if (error) err(ctx, 500, "internal_error", error.message);

  await syncCampaignSessions(supabase, ctx, data.id, sessionIds);

  await audit({
    organizationId: ctx.organization_id,
    actorUserId: userId,
    action: "whatsapp_campaigns.created",
    resourceType: "whatsapp_campaigns",
    resourceId: data.id,
    requestId: ctx.requestId,
    metadata: {
      reply_stop_mode: body.reply_stop_mode,
      create_lead_on_reply: body.create_lead_on_reply,
      channel_session_ids: sessionIds,
    },
  });
  return getCampaignHandler(supabase, ctx, data.id);
}

export async function patchCampaignHandler(
  supabase: SB,
  ctx: HandlerCtx,
  userId: string,
  id: string,
  raw: unknown,
) {
  const existing = await getCampaignHandler(supabase, ctx, id);
  if (!["draft", "scheduled", "paused"].includes(existing.status)) {
    err(ctx, 422, "validation_failed", "Campanha não pode ser editada neste status.");
  }
  const body = campaignPatchSchema.parse(raw);
  if (body.message_text) {
    const tpl = validateCampaignTemplate(body.message_text);
    if (!tpl.ok) {
      err(ctx, 422, "validation_failed", `Variáveis inválidas: ${tpl.unknown.join(", ")}`);
    }
  }

  const sessionIds =
    body.channel_session_ids || body.channel_session_id
      ? resolveSessionIds(body)
      : null;

  const {
    channel_session_ids: _ids,
    channel_session_id: _sid,
    ...campaignFields
  } = body;
  void _ids;
  void _sid;

  const patch: Record<string, unknown> = { ...campaignFields };
  if (sessionIds && sessionIds.length > 0) {
    patch.channel_session_id = sessionIds[0];
  }

  const { data, error } = await supabase
    .from("whatsapp_campaigns")
    .update(patch)
    .eq("organization_id", ctx.organization_id)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) err(ctx, 500, "internal_error", error.message);
  if (!data) err(ctx, 404, "not_found", "Campanha não encontrada.");

  if (sessionIds) {
    await syncCampaignSessions(supabase, ctx, id, sessionIds);
    await audit({
      organizationId: ctx.organization_id,
      actorUserId: userId,
      action: "whatsapp_campaigns.sessions_updated",
      resourceType: "whatsapp_campaigns",
      resourceId: id,
      requestId: ctx.requestId,
      metadata: { channel_session_ids: sessionIds },
    });
  }

  if (body.reply_stop_mode !== undefined && body.reply_stop_mode !== existing.reply_stop_mode) {
    await audit({
      organizationId: ctx.organization_id,
      actorUserId: userId,
      action: "whatsapp_campaigns.reply_stop_mode_changed",
      resourceType: "whatsapp_campaigns",
      resourceId: id,
      requestId: ctx.requestId,
      metadata: { from: existing.reply_stop_mode, to: body.reply_stop_mode },
    });
  }
  if (
    body.create_lead_on_reply !== undefined &&
    body.create_lead_on_reply !== existing.create_lead_on_reply
  ) {
    await audit({
      organizationId: ctx.organization_id,
      actorUserId: userId,
      action: "whatsapp_campaigns.create_lead_on_reply_changed",
      resourceType: "whatsapp_campaigns",
      resourceId: id,
      requestId: ctx.requestId,
      metadata: { create_lead_on_reply: body.create_lead_on_reply },
    });
  }

  await audit({
    organizationId: ctx.organization_id,
    actorUserId: userId,
    action: "whatsapp_campaigns.updated",
    resourceType: "whatsapp_campaigns",
    resourceId: id,
    requestId: ctx.requestId,
  });
  return getCampaignHandler(supabase, ctx, id);
}

export async function addRecipientsHandler(
  supabase: SB,
  ctx: HandlerCtx,
  userId: string,
  id: string,
  raw: unknown,
) {
  const camp = await getCampaignHandler(supabase, ctx, id);
  if (!["draft", "scheduled", "paused"].includes(camp.status)) {
    err(ctx, 422, "validation_failed", "Não dá para alterar destinatários neste status.");
  }
  const selection = audienceSelectionSchema.parse(raw);
  const result = await materializeCampaignAudience(supabase, {
    organizationId: ctx.organization_id,
    campaignId: id,
    channelSessionId: camp.channel_session_id,
    messageTemplate: camp.message_text,
    selection,
  });
  await audit({
    organizationId: ctx.organization_id,
    actorUserId: userId,
    action: "whatsapp_campaigns.recipients_added",
    resourceType: "whatsapp_campaigns",
    resourceId: id,
    requestId: ctx.requestId,
    metadata: result as unknown as Record<string, unknown>,
  });
  return result;
}

export async function listRecipientsHandler(
  supabase: SB,
  ctx: HandlerCtx,
  id: string,
  status?: string | null,
) {
  await getCampaignHandler(supabase, ctx, id);
  let q = supabase
    .from("whatsapp_campaign_recipients")
    .select(
      "id, contact_id, person_id, company_id, channel_session_id, phone_number_snapshot, contact_name_snapshot, person_name_snapshot, company_name_snapshot, status, attempt_count, last_error, skipped_reason, sent_at, replied_at, next_attempt_at, created_at, uncertainty_resolution, uncertainty_resolved_at",
    )
    .eq("organization_id", ctx.organization_id)
    .eq("campaign_id", id)
    .order("created_at", { ascending: true })
    .limit(200);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) err(ctx, 500, "internal_error", error.message);
  return data ?? [];
}

export async function previewCampaignHandler(supabase: SB, ctx: HandlerCtx, id: string) {
  const camp = await getCampaignHandler(supabase, ctx, id);
  const { data } = await supabase
    .from("whatsapp_campaign_recipients")
    .select(
      "phone_number_snapshot, person_name_snapshot, company_name_snapshot, contact_name_snapshot, message_rendered",
    )
    .eq("organization_id", ctx.organization_id)
    .eq("campaign_id", id)
    .eq("status", "pending")
    .limit(5);
  const samples =
    data?.map((r) => ({
      phone: r.phone_number_snapshot,
      name: r.person_name_snapshot || r.contact_name_snapshot,
      company: r.company_name_snapshot,
      message:
        r.message_rendered ||
        renderCampaignTemplate(camp.message_text, {
          full_name: r.person_name_snapshot || r.contact_name_snapshot,
          first_name: firstNameFrom(r.person_name_snapshot || r.contact_name_snapshot),
          company_name: r.company_name_snapshot,
        }),
    })) ?? [];
  return { samples };
}

export async function campaignStatsHandler(supabase: SB, ctx: HandlerCtx, id: string) {
  const camp = await getCampaignHandler(supabase, ctx, id);
  const { data, error } = await supabase.rpc("fn_whatsapp_campaign_status_counts", {
    p_organization_id: ctx.organization_id,
    p_campaign_ids: [id],
  });
  if (error) err(ctx, 500, "internal_error", error.message);
  const counts: Record<string, number> = {};
  for (const s of RECIPIENT_STATUSES) counts[s] = 0;
  let total = 0;
  for (const row of data ?? []) {
    const n = Number(row.n);
    counts[row.status as string] = n;
    total += n;
  }
  const sentLike =
    (counts.sent ?? 0) +
    (counts.delivered ?? 0) +
    (counts.read ?? 0) +
    (counts.replied ?? 0) +
    (counts.assumed_sent ?? 0);
  const replied = counts.replied ?? 0;
  const reply_rate = sentLike > 0 ? replied / sentLike : 0;

  const { data: sessionStats, error: sessErr } = await supabase.rpc(
    "fn_whatsapp_campaign_session_stats",
    {
      p_organization_id: ctx.organization_id,
      p_campaign_id: id,
    },
  );
  if (sessErr) err(ctx, 500, "internal_error", sessErr.message);

  const sessionMeta = new Map(
    ((camp as { sessions?: Array<Record<string, unknown>> }).sessions ?? []).map((s) => [
      s.channel_session_id as string,
      s,
    ]),
  );

  const by_session = (sessionStats ?? []).map((row: Record<string, unknown>) => {
    const sid = row.channel_session_id as string;
    const meta = sessionMeta.get(sid) as
      | {
          enabled?: boolean;
          channel_sessions?: {
            display_name?: string | null;
            phone_number?: string | null;
            status?: string;
          };
        }
      | undefined;
    const cs = meta?.channel_sessions;
    return {
      channel_session_id: sid,
      label: cs?.display_name || cs?.phone_number || sid.slice(0, 8),
      phone_number: cs?.phone_number ?? null,
      status: cs?.status ?? "unknown",
      enabled: meta?.enabled ?? true,
      sent: Number(row.sent ?? 0),
      failed: Number(row.failed ?? 0),
      replied: Number(row.replied ?? 0),
      last_sent_at: row.last_sent_at ?? null,
    };
  });

  return {
    total,
    counts,
    reply_rate,
    replied,
    sent_like: sentLike,
    by_session,
    session_problem: (camp as { session_problem?: string | null }).session_problem ?? null,
    awaiting_session:
      (camp as { session_problem?: string | null }).session_problem ===
        "awaiting_whatsapp_session" ||
      (camp as { session_problem?: string | null }).session_problem === "awaiting_session_lease",
  };
}

export async function startCampaignHandler(
  supabase: SB,
  ctx: HandlerCtx,
  userId: string,
  id: string,
) {
  const camp = await getCampaignHandler(supabase, ctx, id);
  if (!["draft", "scheduled", "paused"].includes(camp.status)) {
    err(ctx, 422, "validation_failed", "Campanha não pode ser iniciada neste status.");
  }
  const tpl = validateCampaignTemplate(camp.message_text);
  if (!tpl.ok) {
    err(ctx, 422, "validation_failed", `Variáveis inválidas: ${tpl.unknown.join(", ")}`);
  }
  await assertAnySessionWorking(supabase, ctx, id);

  const { count } = await supabase
    .from("whatsapp_campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ctx.organization_id)
    .eq("campaign_id", id)
    .eq("status", "pending");
  if (!count) err(ctx, 422, "validation_failed", "Adicione destinatários elegíveis antes de iniciar.");

  const next = nextSendAtIso(camp.min_interval_seconds, camp.max_interval_seconds);
  await supabase
    .from("whatsapp_campaign_sessions")
    .update({ next_send_at: next })
    .eq("organization_id", ctx.organization_id)
    .eq("campaign_id", id)
    .eq("enabled", true);

  const { data, error } = await supabase
    .from("whatsapp_campaigns")
    .update({
      status: "running",
      started_at: camp.started_at ?? new Date().toISOString(),
      paused_at: null,
      next_send_at: next,
      session_problem: null,
    })
    .eq("organization_id", ctx.organization_id)
    .eq("id", id)
    .select("*")
    .single();
  if (error) err(ctx, 500, "internal_error", error.message);

  await audit({
    organizationId: ctx.organization_id,
    actorUserId: userId,
    action: "whatsapp_campaigns.started",
    resourceType: "whatsapp_campaigns",
    resourceId: id,
    requestId: ctx.requestId,
  });
  return data;
}

export async function pauseCampaignHandler(
  supabase: SB,
  ctx: HandlerCtx,
  userId: string,
  id: string,
) {
  const camp = await getCampaignHandler(supabase, ctx, id);
  if (camp.status !== "running") {
    err(ctx, 422, "validation_failed", "Só campanhas em execução podem pausar.");
  }
  const { data, error } = await supabase
    .from("whatsapp_campaigns")
    .update({ status: "paused", paused_at: new Date().toISOString() })
    .eq("organization_id", ctx.organization_id)
    .eq("id", id)
    .select("*")
    .single();
  if (error) err(ctx, 500, "internal_error", error.message);
  await audit({
    organizationId: ctx.organization_id,
    actorUserId: userId,
    action: "whatsapp_campaigns.paused",
    resourceType: "whatsapp_campaigns",
    resourceId: id,
    requestId: ctx.requestId,
  });
  return data;
}

export async function resumeCampaignHandler(
  supabase: SB,
  ctx: HandlerCtx,
  userId: string,
  id: string,
) {
  const camp = await getCampaignHandler(supabase, ctx, id);
  if (camp.status !== "paused") {
    err(ctx, 422, "validation_failed", "Só campanhas pausadas podem retomar.");
  }
  await assertAnySessionWorking(supabase, ctx, id);
  // Sem burst: next_send_at = now + intervalo aleatório
  const next = nextSendAtIso(camp.min_interval_seconds, camp.max_interval_seconds);
  await supabase
    .from("whatsapp_campaign_sessions")
    .update({ next_send_at: next })
    .eq("organization_id", ctx.organization_id)
    .eq("campaign_id", id)
    .eq("enabled", true);
  const { data, error } = await supabase
    .from("whatsapp_campaigns")
    .update({
      status: "running",
      paused_at: null,
      next_send_at: next,
      session_problem: null,
    })
    .eq("organization_id", ctx.organization_id)
    .eq("id", id)
    .select("*")
    .single();
  if (error) err(ctx, 500, "internal_error", error.message);
  await audit({
    organizationId: ctx.organization_id,
    actorUserId: userId,
    action: "whatsapp_campaigns.resumed",
    resourceType: "whatsapp_campaigns",
    resourceId: id,
    requestId: ctx.requestId,
  });
  return data;
}

export async function cancelCampaignHandler(
  supabase: SB,
  ctx: HandlerCtx,
  userId: string,
  id: string,
) {
  await getCampaignHandler(supabase, ctx, id);
  const { data, error } = await supabase
    .from("whatsapp_campaigns")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
    })
    .eq("organization_id", ctx.organization_id)
    .eq("id", id)
    .select("*")
    .single();
  if (error) err(ctx, 500, "internal_error", error.message);

  await supabase
    .from("whatsapp_campaign_recipients")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("organization_id", ctx.organization_id)
    .eq("campaign_id", id)
    .in("status", ["pending", "scheduled"]);

  await audit({
    organizationId: ctx.organization_id,
    actorUserId: userId,
    action: "whatsapp_campaigns.cancelled",
    resourceType: "whatsapp_campaigns",
    resourceId: id,
    requestId: ctx.requestId,
  });
  return data;
}
