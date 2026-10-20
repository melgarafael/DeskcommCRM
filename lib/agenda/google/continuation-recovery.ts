import type { SupabaseClient } from "@supabase/supabase-js";
import { execucaoDoServico } from "@/lib/agenda/servicos/escrita";
import { currentExecutionJob, deferForGooglePublication, guardServiceEffect } from "@/lib/atendimento/fronteira-server";
import { publicationReceipt } from "./publication-flow";
import { googleRpc } from "./sync-store";
import type { PublicacaoAgendaObservada } from "@/lib/agenda/recibo-do-turno";

/** Explicit follow-up to the same stored reservation. Never books or writes Google.
 * The native SQL function captures the current inbound and validates the prior
 * reservation/demand/revisions and all genuine human/lease guards again.
 */
export async function resumeGooglePublication(db: SupabaseClient, org: string, appointmentIds: string[], onPublished?: (proof: PublicacaoAgendaObservada) => void) {
  await guardServiceEffect();
  const execution = execucaoDoServico();
  if (!execution || currentExecutionJob()?.kind !== "inbound_turn")
    return { resumed: false, reason: "current_inbound_required" };
  const ids = [...new Set(appointmentIds)].sort();
  // Bracket native adoption with the monotonic reservation revision. A later
  // publication must not be attributed to the request that adopted an older one.
  let before: {id: unknown; revision: unknown} | undefined;
  if (onPublished && ids.length === 1) {
    const {data, error} = await db.from("calendar_appointments").select("id,revision")
      .eq("organization_id", org).in("id", ids);
    if (error) throw new Error("google_publication_receipt_unavailable");
    if (data?.length === 1) before = data[0];
  }
  const result = await googleRpc(db, "fn_google_continuation_resume", {
    p_org: org, p_ids: ids, p_execution: execution,
  }) as { resumed: boolean; reason?: string; deferred?: boolean; state?: string };
  if (!result.resumed) return result;
  const { data, error } = await db.from("calendar_appointments").select("*").eq("organization_id", org).in("id", ids);
  if (error || !data || data.length !== ids.length) throw new Error("google_publication_receipt_unavailable");
  const receipts = ids.map((id) => publicationReceipt(data.find((r: Record<string, unknown>) => r.id === id)!));
  if (result.deferred) deferForGooglePublication();
  // Only the native recovery of this request may seed an observation. A group
  // is never collapsed into proof of its first reservation, and a plain read
  // cannot claim a new write. The scoped context is read again by the caller.
  if (result.deferred === false && result.state === "inline" && receipts.length === 1) {
    const receipt = receipts[0]!;
    const revision = Number(receipt.revision);
    if (before && before.id === receipt.id && Number(before.revision) === revision &&
        receipt.status === "confirmed" && receipt.google_publication === "synced" &&
        typeof receipt.id === "string" && Number.isSafeInteger(revision) && revision > 0)
      onPublished?.({ reservaId: receipt.id, revisao: revision });
  }
  return { ...result, appointments: receipts,
    message: result.deferred
      ? "A mesma reserva está em recuperação. Aguarde a continuação nativa após a prova atual; espera transitória não abre Caso nem exige aprovação humana. Não reserve novamente."
      : "Releia o recibo atual. Confirme somente publicação comprovada e siga as instruções vigentes; não reserve novamente. Falha humana real ou aprovação humana configurada continuam exigindo equipe.",
  };
}
