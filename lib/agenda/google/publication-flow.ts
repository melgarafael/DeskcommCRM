import type { SupabaseClient } from "@supabase/supabase-js";
import { currentExecutionJob, deferForGooglePublication } from "@/lib/atendimento/fronteira-server";
import { execucaoDoServico, reciboDoServico } from "@/lib/agenda/servicos/escrita";
import { googleRpc } from "./sync-store";
import { reconcileAppointment } from "./sync-executor";
import { googlePublication } from "./publication";

/** No public input can authorize a continuation. The native lease is checked again in SQL. */
export function nativePublicationBooking() {
  const job = currentExecutionJob();
  return !!job && ["inbound_turn", "followup_turn", "case_reply_turn"].includes(job.kind);
}

export function publicationReceipt(row: Record<string, unknown>, configured = true) {
  if (row.service_occurrence_id) return reciboDoServico(row);
  return {
    id: row.id, starts_at: row.starts_at, ends_at: row.ends_at, status: row.status,
    time_zone: row.time_zone, revision: row.revision,
    meeting_state: row.meeting_state, meeting_url: row.meeting_url,
    google_publication: configured ? googlePublication(row) : "not_configured", human_confirmation: row.status === "pending" ? "pending" : "not_required", communication: "not_proven",
  };
}

/** The same deadline covers all Google requests in a booking, including a group.
 * The executor releases its claim and persists recovery; no detached write survives a timeout.
 * Supabase RPCs are individual transactions: no connection is held across Google HTTP.
 */
export async function publishBookingNow(db: SupabaseClient, org: string, receipt: Record<string, unknown>, operation: string) {
  const items = Array.isArray(receipt.appointments) ? receipt.appointments : [receipt];
  const ids = items.map((r) => (r as Record<string, unknown>).id).filter((id): id is string => typeof id === "string");
  if (!ids.length) return receipt;
  const { data: saved, error: savedError } = await db.from("calendar_appointments").select("*").eq("organization_id", org).in("id", ids);
  if (savedError || !saved || saved.length !== ids.length) throw new Error("google_publication_receipt_unavailable");
  const owners = [...new Set(saved.filter((r: Record<string, unknown>) => !r.service_occurrence_id && r.owner_user_id).map((r: Record<string, unknown>) => String(r.owner_user_id)))];
  const connections = owners.length ? await db.from("calendar_connections").select("user_id").eq("organization_id", org).in("user_id", owners) : { data: [], error: null };
  if (connections.error) throw new Error("google_publication_configuration_unavailable");
  const connected = new Set((connections.data ?? []).map((r: { user_id: string }) => r.user_id));
  const configured = (r: Record<string, unknown>) => r.service_occurrence_id ? r.service_publication_mode !== "none"
    : !!r.google_event_id || r.location_kind === "google_meet" || connected.has(String(r.owner_user_id));
  const publishIds = ids.filter((id) => configured(saved.find((r: Record<string, unknown>) => r.id === id)!));
  if (!publishIds.length) {
    const receipts = ids.map((id) => publicationReceipt(saved.find((r: Record<string, unknown>) => r.id === id)!, false));
    return { ...receipt, ...receipts[0], ...(ids.length > 1 ? { appointments: receipts } : {}) };
  }
  const execution = nativePublicationBooking() ? execucaoDoServico() : null;
  const registration = execution ? await googleRpc(db, "fn_google_continuation_register", {
    p_org: org, p_ids: [...publishIds].sort(), p_operation: operation, p_execution: execution,
  }) as { id?: string; state?: string } | null : null;
  const finish = () => googleRpc(db, "fn_google_continuation_finish", {
    p_org: org, p_id: registration!.id, p_source_job: currentExecutionJob()?.id,
  }) as Promise<{ deferred: boolean; state: string }>;
  const previous = registration?.id && registration.state !== "attempting" ? await finish() : null;
  const deadline = AbortSignal.timeout(4_000);
  for (const id of publishIds) {
    if (previous || deadline.aborted) break;
    try { await reconcileAppointment(db, org, id, { signal: deadline }); }
    catch { /* A competing claim, connection/configuration error or uncertain write remains recoverable. */ }
  }
  // This atomic handoff closes the race between the inline attempt and cron acknowledgement.
  const outcome = previous ?? (registration?.id ? await finish() : null);
  const { data, error } = await db.from("calendar_appointments").select("*").eq("organization_id", org).in("id", ids);
  if (error || !data || data.length !== ids.length) throw new Error("google_publication_receipt_unavailable");
  const rows = ids.map((id) => data.find((r: Record<string, unknown>) => r.id === id)!);
  const receipts = rows.map((r: Record<string, unknown>) => publicationReceipt(r, configured(r)));
  if (outcome?.deferred) deferForGooglePublication();
  return { ...receipt, ...receipts[0], ...(ids.length > 1 ? { appointments: receipts } : {}),
    ...(outcome?.deferred ? { attendance_continuation: outcome.state === "stale" ? "superseded" : "waiting_for_publication" } : {}) };
}
