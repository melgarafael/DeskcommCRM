/**
 * Handler adapter exposing lgpd-redact-worker to the event_log dispatcher.
 *
 * Consumed key: `lgpd-redact-worker.v1` — recorded in
 * `event_log.consumed_by[]` so retries skip already-completed runs.
 */

import type { EventHandler } from "@/lib/event-log/dispatcher";
import { processLgpdRedact } from "@/workers/lgpd-redact-worker";

export const LGPD_REDACT_HANDLER_KEY = "lgpd-redact-worker.v1";

export const lgpdRedactHandler: EventHandler = {
  key: LGPD_REDACT_HANDLER_KEY,
  naOrgParada: "roda",
  events: ["lgpd.redact_received"],
  async handle(row) {
    return processLgpdRedact(row);
  },
};
