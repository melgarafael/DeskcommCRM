/**
 * Cron driver genérico do event_log — a peça prometida em dispatcher.ts.
 *
 * Seleciona SÓ event_types com handler registrado: tipos drenados por crons
 * dedicados (ex. ai_agent.dispatch_requested → agent-dispatcher) não têm
 * handler no registry e ficam intocados.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  dispatchEvent,
  getRegisteredHandlers,
  type EventRow,
} from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";

const MAX_ATTEMPTS = 5;

export interface DrainSummary {
  scanned: number;
  done: number;
  retried: number;
  failed: number;
  dead: number;
}

function backoffAt(attempts: number): string {
  // 1min, 2min, 4min, 8min... (2^n minutos)
  const minutes = Math.pow(2, attempts);
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export async function drainEventLog(
  admin: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<DrainSummary> {
  const limit = opts.limit ?? 50;
  const summary: DrainSummary = { scanned: 0, done: 0, retried: 0, failed: 0, dead: 0 };

  const handledTypes = [...new Set(getRegisteredHandlers().flatMap((h) => h.events))];
  if (!handledTypes.length) return summary;

  const nowIso = new Date().toISOString();
  const { data: rows, error } = await admin
    .from("event_log")
    .select("id, organization_id, event_type, entity_kind, entity_id, payload, metadata, consumed_by, attempts")
    .eq("status", "pending")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
    .in("event_type", handledTypes)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    logger.error("[event-log.drain] select failed", { error: error.message });
    return summary;
  }

  for (const raw of rows ?? []) {
    const row = raw as unknown as EventRow;
    summary.scanned += 1;

    // Claim otimista — outra instância pode ter pego a mesma linha.
    const { data: claimed } = await admin
      .from("event_log")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id");
    if (!claimed?.length) continue;

    const results = await dispatchEvent(row);

    const okKeys = results.filter((r) => r.status === "ok" || r.status === "skipped").map((r) => r.consumer_key);
    const consumedBy = [...new Set([...row.consumed_by, ...okKeys])];
    const retry = results.find((r) => r.status === "retry");
    const errors = results.filter((r) => r.status === "error");

    if (retry) {
      // Reagendamento benigno (ex. janela anti-ban): NÃO conta attempt — mesmo
      // que outro handler do mesmo tick tenha retornado erro (esse handler
      // nunca entrou em consumed_by, então ele reroda no próximo tick; aqui só
      // preservamos o last_error dele pra visibilidade/observabilidade).
      // retry_at é opcional no HandlerResult — sem ele, aplica o mesmo backoff
      // do branch de erro pra não busy-loop reprocessando a cada tick.
      const retryAt = retry.retry_at ?? backoffAt(row.attempts + 1);
      await admin
        .from("event_log")
        .update({
          status: "pending",
          consumed_by: consumedBy,
          next_attempt_at: retryAt,
          updated_at: new Date().toISOString(),
          ...(errors.length
            ? { last_error: errors.map((e) => `${e.consumer_key}: ${e.detail ?? "error"}`).join("; ") }
            : {}),
        })
        .eq("id", row.id);
      summary.retried += 1;
    } else if (errors.length) {
      const attempts = row.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await admin
        .from("event_log")
        .update({
          status: dead ? "dead" : "pending",
          attempts,
          consumed_by: consumedBy,
          last_error: errors.map((e) => `${e.consumer_key}: ${e.detail ?? "error"}`).join("; "),
          next_attempt_at: dead ? null : backoffAt(attempts),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      summary[dead ? "dead" : "failed"] += 1;
    } else {
      await admin
        .from("event_log")
        .update({ status: "done", consumed_by: consumedBy, updated_at: new Date().toISOString() })
        .eq("id", row.id);
      summary.done += 1;
    }
  }
  return summary;
}
