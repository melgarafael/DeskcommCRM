/**
 * Handler adapter exposing lgpd-export-worker to the event_log dispatcher.
 *
 * Consumed key: `lgpd-export-worker.v1` — recorded in
 * `event_log.consumed_by[]` so retries skip already-completed runs.
 */

import type { EventHandler } from "@/lib/event-log/dispatcher";
import { processLgpdExport } from "@/workers/lgpd-export-worker";

export const LGPD_EXPORT_HANDLER_KEY = "lgpd-export-worker.v1";

export const lgpdExportHandler: EventHandler = {
  key: LGPD_EXPORT_HANDLER_KEY,
  naOrgParada: "roda",
  events: ["lgpd.data_request_received"],
  async handle(row) {
    return processLgpdExport(row);
  },
};
