import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { currentExecutionAgentOperation, currentExecutionBoundary, currentExecutionJob } from "@/lib/atendimento/fronteira-server";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import { googleRpc } from "../google/sync-store";
import { MOTIVOS_DO_SERVICO } from "./consulta";

/** Origem interna. Não há um campo de ferramenta que permita fornecer esta autorização. */
export function execucaoDoServico() {
  const job = currentExecutionJob();
  const claim = job ? claimOfJob(job) : null;
  if (!job && !currentExecutionBoundary()) return null;
  return {
    boundary: currentExecutionBoundary(),
    job: job && claim ? { id: job.id, worker_id: claim.worker_id, acquired_at: claim.acquired_at } : null,
    agent_operation: currentExecutionAgentOperation(),
  };
}

// A linha inteira inclui notas, claims e corpos de escrita Google. Nenhum deles é resposta de tool.
const reciboSchema = z.object({
  id: z.uuid(), starts_at: z.string(), ends_at: z.string(), time_zone: z.string(),
  status: z.enum(["pending", "confirmed", "cancelled", "completed", "no_show"]),
  revision: z.coerce.number(), owner_user_id: z.uuid().nullable(),
  service_occurrence_id: z.uuid(), participant_name: z.string().nullable(),
  service_booking_mode: z.string(), service_capacity_rule: z.string(), service_capacity_limit: z.number().nullable(),
  service_rule_revision: z.coerce.number(), service_publication_mode: z.string(),
  service_requires_confirmation: z.boolean(),
  meeting_state: z.string(), meeting_url: z.string().nullable(), deduplicated: z.boolean().optional(),
});

export function reciboDoServico(raw: unknown) {
  const row = reciboSchema.parse(raw);
  const privateRow = z.object({
    google_event_id: z.string().nullable(), google_synced_local_revision: z.coerce.number(), google_local_revision: z.coerce.number(),
    google_conflict: z.unknown(), google_sync_error: z.string().nullable().optional(),
    service_confirmed_by_user_id: z.uuid().nullable().default(null), service_confirmed_at: z.string().nullable().default(null),
  }).parse(raw);
  const publication = row.service_publication_mode === "none" ? "not_configured"
    : privateRow.google_conflict ? "conflict"
    : privateRow.google_sync_error ? "failed"
    : privateRow.google_event_id && privateRow.google_synced_local_revision === privateRow.google_local_revision ? row.status === "cancelled" ? "removed" : "synced" : "pending";
  const human = !row.service_requires_confirmation ? "not_required" : row.status === "pending" ? "pending"
    : row.status !== "confirmed" ? "not_applicable" : privateRow.service_confirmed_by_user_id && privateRow.service_confirmed_at ? "confirmed" : "check_human_record";
  return { ...row, google_publication: publication, communication: "not_proven", human_confirmation: human,
    ...(human === "confirmed" ? { human_confirmed_at: privateRow.service_confirmed_at } : {}) };
}

export async function rpcDoServico(db: SupabaseClient, ctx: HandlerCtx, name: string, args: Record<string, unknown>, includeActor = true): Promise<unknown> {
  try {
    return await googleRpc(db, name, { p_org: ctx.organization_id, ...(includeActor ? { p_actor: { ...ctx.actor, ...(ctx.sourceJobId ? { native_job: ctx.sourceJobId } : {}) } } : {}), ...args });
  } catch (error) {
    const e = error as { message?: string; code?: string };
    const reason = e.message ?? "";
    throw new ApiError(e.code === "42501" ? 403 : e.code === "P0002" ? 404 : e.code === "PT409" || e.code === "40001" ? 409 : 422,
      e.code === "42501" ? "forbidden" : e.code === "P0002" ? "not_found" : "validation_failed", undefined, ctx.requestId,
      MOTIVOS_DO_SERVICO[reason] ?? "Não foi possível concluir a reserva. Confira o pedido e consulte os horários novamente.");
  }
}
