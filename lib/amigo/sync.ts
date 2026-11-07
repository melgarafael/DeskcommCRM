import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadAmigoConnection } from "./store";
import { requestAmigo } from "./transport";
import { normalizeAttendance, amigoInstant, projectAttendance } from "./projection";
import { diaLocalISO } from "@/lib/agenda/fuso";
import { AmigoDomainError } from "./access";

/** Small disjoint windows, civil dates in the clinic's timezone. */
export function syncWindows(now: Date, timezone: string) {
  const day = new Date(diaLocalISO(now, timezone) + "T12:00:00Z");
  const date = (offset: number) =>
    new Date(day.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  const windows: Array<{ start_date: string; end_date: string }> = [];
  for (let start = -7; start <= 90; start += 7)
    windows.push({ start_date: date(start), end_date: date(Math.min(start + 6, 90)) });
  return windows;
}
interface PendingOperation {
  operation: string;
  request_context: Record<string, unknown>;
}
export function matchReconciliation(
  op: PendingOperation,
  raw: unknown[],
  timezone: string,
): { data: unknown; status: "success" } | null {
  const q = op.request_context;
  const matches = raw.filter((row) => {
    try {
      const a = normalizeAttendance(row, timezone);
      if (op.operation === "attendance_create")
        return (
          a.patientId === q.patient_id &&
          a.eventId === q.event_id &&
          a.doctorId === q.user_id &&
          a.placeId === q.place_id &&
          a.startsAt === amigoInstant(String(q.start_date), timezone)
        );
      if (a.remoteId !== Number(q.id ?? q.attendance_id)) return false;
      if (op.operation === "attendance_cancel") return a.remoteStatus === "canceled";
      if (op.operation === "attendance_status")
        return a.patientId === q.patient_id && a.remoteStatus === q.status;
      if (op.operation === "attendance_reschedule")
        return a.startsAt === amigoInstant(String(q.date), timezone);
      return false;
    } catch {
      return false;
    }
  });
  return matches.length === 1
    ? { data: op.operation === "attendance_create" ? matches[0] : true, status: "success" }
    : null;
}
export function reminderMatches(
  local: { starts_at: string; contact_id: string },
  raw: unknown,
  timezone: string,
  linkedContact: string,
) {
  try {
    const remote = normalizeAttendance(raw, timezone);
    return (
      linkedContact === local.contact_id &&
      ["scheduled", "confirmed"].includes(remote.remoteStatus) &&
      remote.startsAt === new Date(local.starts_at).toISOString()
    );
  } catch {
    return false;
  }
}

/** Internal scheduler boundary; HTTP caller checks management or cron secret. */
export async function syncAmigo(organizationId: string, requestId: string) {
  const connection = await loadAmigoConnection(organizationId);
  if (!connection?.active)
    throw new AmigoDomainError(
      "amigo_inactive",
      422,
      "Ative a integração para atualizar a agenda.",
    );
  const db = createAdminClient();
  const { data: org } = await db
    .from("organizations")
    .select("status")
    .eq("id", organizationId)
    .maybeSingle();
  if (org?.status !== "active")
    throw new AmigoDomainError("org_suspended", 403, "Esta clínica está com a operação pausada.");
  const deadline = Date.now() + 40_000;
  let count = 0;
  try {
    for (const window of syncWindows(new Date(), connection.timezone)) {
      if (Date.now() > deadline) throw new Error("sync_budget");
      const response = await requestAmigo(
        connection.token,
        "attendances",
        { ...window, status: "ALL" },
        { timeoutMs: 5000 },
      );
      const rows = Array.isArray(response.data) ? response.data : [];
      for (const row of rows) {
        if (Date.now() > deadline) throw new Error("sync_budget");
        await projectAttendance(
          db,
          { id: connection.id, organizationId, timezone: connection.timezone },
          row,
          {
            bootstrap: connection.last_sync_at === null,
            actor: { type: "api_token", id: "amigo-sync", role: "manager" },
          },
        );
        count++;
      }
    }
    // Read only: evidence can finish an uncertain receipt; absence never authorizes resend.
    const { data: pending, error: pendingError } = await db
      .from("amigo_operations")
      .select("id,operation,request_context")
      .eq("organization_id", organizationId)
      .eq("connection_id", connection.id)
      .in("state", ["sent", "uncertain"])
      .lt("updated_at", new Date(Date.now() - 60_000).toISOString())
      .order("created_at")
      .limit(20);
    if (pendingError) throw new Error("receipts_unavailable");
    let reconciled = 0;
    for (const op of pending ?? []) {
      if (Date.now() > deadline) break;
      const q = op.request_context as Record<string, unknown>;
      let patientId = q.patient_id;
      if (!patientId && (q.id ?? q.attendance_id)) {
        const { data: link } = await db
          .from("amigo_appointment_links")
          .select("patient_id")
          .eq("organization_id", organizationId)
          .eq("connection_id", connection.id)
          .eq("attendance_id", q.id ?? q.attendance_id)
          .maybeSingle();
        patientId = link?.patient_id;
      }
      if (!patientId) continue;
      const response = await requestAmigo(
        connection.token,
        "patient_attendances",
        { patient_id: patientId },
        { timeoutMs: 5000 },
      );
      const result = matchReconciliation(
        { operation: op.operation, request_context: q },
        Array.isArray(response.data) ? response.data : [],
        connection.timezone,
      );
      if (!result) continue;
      const { error } = await db
        .from("amigo_operations")
        .update({ state: "confirmed", result, updated_at: new Date().toISOString() })
        .eq("organization_id", organizationId)
        .eq("connection_id", connection.id)
        .eq("id", op.id)
        .in("state", ["sent", "uncertain"]);
      if (error) throw new Error("receipt_pending");
      reconciled++;
    }
    const { error } = await db
      .from("amigo_connections")
      .update({ last_sync_at: new Date().toISOString(), last_error: null })
      .eq("organization_id", organizationId)
      .eq("id", connection.id);
    if (error) throw new Error("sync_receipt_pending");
    return { examined: count, reconciled, request_id: requestId };
  } catch {
    await db
      .from("amigo_connections")
      .update({
        last_error: "sync_failed",
      })
      .eq("organization_id", organizationId)
      .eq("id", connection.id);
    throw new AmigoDomainError(
      "amigo_sync_failed",
      503,
      "A agenda não foi totalmente atualizada. Confira a conexão; nenhuma operação incerta foi reenviada.",
    );
  }
}

/** Before any outgoing reminder, re-read the actual appointment in its original account. */
export async function verifyAmigoReminder(
  db: ReturnType<typeof createAdminClient>,
  local: {
    id: string;
    organization_id: string;
    contact_id: string;
    starts_at: string;
    authority?: string;
    amigo_arrival_window?: string;
    external_connection_id?: string | null;
  },
) {
  if (local.authority !== "amigo") return true;
  try {
    if (!local.external_connection_id) return false;
    const connection = await loadAmigoConnection(
      local.organization_id,
      local.external_connection_id,
    );
    if (!connection?.active || !connection.reminders_enabled) return false;
    const { data: link, error } = await db
      .from("amigo_appointment_links")
      .select("attendance_id,patient_id")
      .eq("organization_id", local.organization_id)
      .eq("connection_id", connection.id)
      .eq("appointment_id", local.id)
      .maybeSingle();
    if (error || !link?.patient_id) return false;
    const { data: patient, error: patientError } = await db
      .from("amigo_patient_links")
      .select("contact_id")
      .eq("organization_id", local.organization_id)
      .eq("connection_id", connection.id)
      .eq("patient_id", link.patient_id)
      .maybeSingle();
    if (patientError || patient?.contact_id !== local.contact_id) return false;
    const response = await requestAmigo(connection.token, "patient_attendances", {
      patient_id: link.patient_id,
    });
    const current = (Array.isArray(response.data) ? response.data : []).find(
      (a) => Number(a.id) === Number(link.attendance_id),
    );
    if (!current) return false;
    const valid = reminderMatches(local, current, connection.timezone, patient.contact_id);
    const normalized = normalizeAttendance(current, connection.timezone);
    if (normalized.arrivalOrder) {
      const shifts: Record<string, string> = {
        MORNING: "manhã",
        AFTERNOON: "tarde",
        NIGHT: "noite",
      };
      local.amigo_arrival_window = `ordem de chegada: ${shifts[normalized.shift ?? ""] ?? "turno informado pela clínica"}${normalized.arrivalWindows.length ? `, ${normalized.arrivalWindows.map((w) => `${w.start}–${w.end}`).join(" / ")}` : normalized.arrivalStart && normalized.arrivalEnd ? `, ${normalized.arrivalStart}–${normalized.arrivalEnd}` : ""}`;
    }
    await projectAttendance(
      db,
      { id: connection.id, organizationId: local.organization_id, timezone: connection.timezone },
      current,
      { actor: { type: "api_token", id: "amigo-reminder-check", role: "manager" } },
    );
    return valid;
  } catch {
    await db
      .from("amigo_connections")
      .update({ last_error: "reminder_verification_failed" })
      .eq("organization_id", local.organization_id)
      .eq("id", local.external_connection_id);
    return false;
  }
}
