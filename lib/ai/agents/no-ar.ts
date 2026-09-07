/** Publication is the source of operational status. Only agent-engine replies;
 * an unpublished legacy row retains configuration and deterministic triage.
 */
export interface FatosDoAgente {
  kind?: string | null;
  is_active?: boolean | null;
  paused_at?: string | null;
  operation_mode?: string;
  published_version_id?: string | null;
  archived_at?: string | null;
}
export type EstadoDoAgente =
  | "arquivado"
  | "no_ar"
  /** Historical value retained for consumers; never emitted by this resolver. */
  | "no_ar_legado"
  | "parado";
export function estadoDoAgente(a: FatosDoAgente): EstadoDoAgente {
  if (a.archived_at != null) return "arquivado";
  if (a.paused_at != null) return "parado";
  return a.published_version_id != null ? "no_ar" : "parado";
}
export function agenteAtende(a: FatosDoAgente): boolean {
  return estadoDoAgente(a) === "no_ar";
}
/** The legacy normal reply produced an orphan sending event; it stays disabled. */
export function elegivelParaWorkerLegado(_a: FatosDoAgente): boolean {
  return false;
}
/** This is eligibility for recovery/zero-model triage, never permission to send. */
export function precisaRecuperarLegado(a: FatosDoAgente): boolean {
  return a.kind === "rag_bot" && a.is_active === true && !a.published_version_id &&
    !a.archived_at && !a.paused_at;
}
