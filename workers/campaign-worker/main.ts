/**
 * Campaign worker — fila em whatsapp_campaign_recipients + SKIP LOCKED.
 * Reusa imagem deskcomm-worker (CMD override no compose).
 */
import http from "node:http";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import { createPool } from "@/lib/agent-engine/db/pool";
import { loadEnv } from "@/lib/agent-engine/env";
import { createLogger, withFields } from "@/lib/agent-engine/obs/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  claimRecipient,
  processClaimedRecipient,
  recoverStaleClaims,
  syncRecipientStatusesFromMessages,
} from "@/lib/whatsapp-campaigns/worker-tick";

const workerId = `campaign-${hostname()}-${process.pid}`;
const log = withFields(createLogger(), { service: "campaign-worker", workerId });

let shuttingDown = false;
let inFlight = 0;

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = createPool(env.SUPABASE_DB_URL, (err) =>
    log.error("pool_error", { error: err.message.slice(0, 300) }),
  );
  const admin = createAdminClient();

  const health = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, workerId, inFlight, shuttingDown }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  health.listen(8788, "0.0.0.0");

  const stop = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown_requested", { inFlight });
    const deadline = Date.now() + 25_000;
    while (inFlight > 0 && Date.now() < deadline) {
      await sleep(200);
    }
    health.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());

  log.info("campaign_worker_boot");

  let syncCounter = 0;
  while (!shuttingDown) {
    try {
      if (++syncCounter % 10 === 0) {
        await recoverStaleClaims(pool, 180);
        await syncRecipientStatusesFromMessages(pool);
      }
      const claimed = await claimRecipient(pool, workerId);
      if (!claimed) {
        await sleep(1500);
        continue;
      }
      inFlight += 1;
      try {
        const result = await processClaimedRecipient(pool, admin, workerId, claimed);
        log.info("campaign_tick", {
          recipient_id: claimed.recipient_id,
          campaign_id: claimed.campaign_id,
          organization_id: claimed.organization_id,
          result,
        });
      } finally {
        inFlight -= 1;
      }
    } catch (err) {
      log.error("campaign_loop_error", {
        err: err instanceof Error ? err.message : String(err),
      });
      await sleep(2000);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
