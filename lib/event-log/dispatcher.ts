/**
 * event_log dispatcher — registry of consumers for domain events.
 *
 * Pattern: each handler declares the event types it consumes. The dispatcher
 * receives an `EventRow` (one row from `public.event_log`) and routes it to
 * every handler whose key has not yet been recorded in `consumed_by`.
 *
 * The actual *cron driver* that drains `event_log` (selects rows where
 * `status='pending'` AND `next_attempt_at <= now()`) is intentionally NOT in
 * this file — that lives in `app/api/v1/cron/event-log-drain/route.ts`
 * (created later in this epic). This module only owns the registry and the
 * single-row dispatch contract.
 */

import { logger } from "@/lib/logger";

export interface EventRow {
  id: string;
  organization_id: string;
  event_type: string;
  entity_kind: string;
  entity_id: string | null;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  consumed_by: string[];
  attempts: number;
}

export interface HandlerResult {
  /** Stable key to push into `event_log.consumed_by`. */
  consumer_key: string;
  status: "ok" | "skipped" | "error";
  detail?: string;
}

export interface EventHandler {
  /** Stable key recorded in `event_log.consumed_by`. */
  key: string;
  /** Event types this handler consumes (`["message.received", "message.sent"]`). */
  events: string[];
  handle(row: EventRow): Promise<HandlerResult>;
}

const _handlers: EventHandler[] = [];
const _registeredKeys = new Set<string>();

export function registerHandler(handler: EventHandler): void {
  if (_registeredKeys.has(handler.key)) {
    // Hot-reload friendly — overwrite by removing prior entry.
    const idx = _handlers.findIndex((h) => h.key === handler.key);
    if (idx >= 0) _handlers.splice(idx, 1);
  }
  _handlers.push(handler);
  _registeredKeys.add(handler.key);
}

export function getRegisteredHandlers(): readonly EventHandler[] {
  return _handlers;
}

/**
 * Match handlers for a single event row, skipping any whose key already lives
 * in `consumed_by`. Returns the per-handler results so the cron driver can
 * decide how to update `consumed_by` / `status` / `attempts`.
 */
export async function dispatchEvent(row: EventRow): Promise<HandlerResult[]> {
  const matches = _handlers.filter(
    (h) => h.events.includes(row.event_type) && !row.consumed_by.includes(h.key),
  );
  if (!matches.length) return [];

  const results: HandlerResult[] = [];
  for (const handler of matches) {
    try {
      const r = await handler.handle(row);
      results.push(r);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error("[event-log.dispatcher] handler threw", {
        handler: handler.key,
        event: row.event_type,
        event_id: row.id,
        error: detail,
      });
      results.push({ consumer_key: handler.key, status: "error", detail });
    }
  }
  return results;
}
