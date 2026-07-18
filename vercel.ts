/**
 * Vercel project config (canonical TS form).
 *
 * Crons placeholder; lista final virá da Spec 08 (Operações & Workers).
 * Os 7 crons abaixo refletem os jobs derivados das specs herdadas:
 *  - recover-stuck-messages (WAHA)
 *  - sync-sessions (WAHA)
 *  - process-pending-webhooks (event_log)
 *  - dispatch-webhooks (deliveries / outbound webhooks)
 *  - lgpd-data-request-worker (D+7 SLA)
 *  - nuvemshop-sync-incremental
 *  - audit-log-archive (cold storage)
 *
 * Auth de cron: header `Authorization: Bearer ${INTERNAL_SECRET}` validado em cada handler.
 */

import type { VercelConfig } from "@vercel/config/v1";

const config: VercelConfig = {
  crons: [
    { path: "/api/v1/cron/lgpd-sla-watcher", schedule: "0 12 * * *" },
    // EPIC-13 S-13.07: drains ai_agent.dispatch_requested events. Vercel cron
    // cannot go sub-minute; per-minute batch of 100 events is sized for the
    // MVP target tenant (~300 inbound/day, headroom ~6k/hour).
    { path: "/api/v1/cron/agent-dispatcher", schedule: "*/1 * * * *" },
    // EPIC-13 G5-02 (AT-03): drena conversation.routing_requested e distribui
    // conversas sem dono por org (round_robin). Per-minute (cap do Vercel) —
    // no-eligible reenfileira com backoff da config (settings.routing).
    { path: "/api/v1/cron/routing-worker", schedule: "*/1 * * * *" },
    // Webhooks/automação: drain genérico do event_log (spec 2026-07-17).
    { path: "/api/v1/cron/event-log-drain", schedule: "*/1 * * * *" },
  ],
  functions: {
    // EPIC-13 S-13.08: ToolLoopAgent runtime can issue multiple tool calls per
    // step. 300s max keeps Fluid Compute within bounds; the runtime's own
    // step/token/cost guards usually finish much earlier.
    "app/api/internal/agents/run/route.ts": { maxDuration: 300 },
  },
};

export default config;
