/** Receipt from the current persisted revision, never from a tool/model assertion. */
export function googlePublication(row: {
  service_occurrence_id?: unknown; service_block?: unknown; service_publication_mode?: unknown;
  google_event_id?: unknown; google_local_revision?: unknown; google_synced_local_revision?: unknown;
  google_conflict?: unknown; google_sync_error?: unknown; google_sync_failure_kind?: unknown;
  needs_google_push?: unknown; status?: unknown;
}) {
  if ((row.service_occurrence_id || row.service_block) && row.service_publication_mode === "none") return "not_configured";
  if (row.google_conflict) return "conflict";
  if (row.google_sync_failure_kind === "human_required") return "failed";
  if (row.google_sync_error) return "retrying";
  if (row.google_event_id && row.google_local_revision != null && row.google_synced_local_revision != null &&
      String(row.google_local_revision) === String(row.google_synced_local_revision) && row.needs_google_push === false)
    return row.status === "cancelled" ? "removed" : "synced";
  return "pending";
}
