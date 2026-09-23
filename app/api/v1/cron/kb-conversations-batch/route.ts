/**
 * GET /api/v1/cron/kb-conversations-batch
 *
 * Daily cron entry point for the conversations RAG ingestion (S-06.07).
 * Iterates active agents (one per org) and runs the anonymizer + chunker +
 * embedder + KB version build for each.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>`. The secret is
 * env-gated and OPTIONAL: when absent, the endpoint refuses every request
 * (fail-closed) so a misconfigured deploy does not silently expose the cron.
 *
 * The legacy `INTERNAL_SECRET` is also accepted to keep parity with other
 * internal cron callers.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { ingestConversationsBatch } from "@/lib/ai/rag/ingest/conversations";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizaCron } from "@/lib/auth/cron-auth";

export const dynamic = "force-dynamic";

const LOOKBACK_HOURS = 24;

interface AgentRow {
  id: string;
  organization_id: string;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const sinceTs = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);

  const { data: agentRows, error: agentErr } = await admin
    .from("ai_agents")
    .select("id, organization_id")
    .eq("is_active", true);

  if (agentErr) {
    console.error("[kb-conversations-cron] agent list failed", agentErr.message);
    return fail("internal_error", agentErr.message, 500, { requestId });
  }

  const agents = (agentRows ?? []) as AgentRow[];
  // Pick one agent per org (first active wins) to avoid double-ingesting.
  const seenOrgs = new Set<string>();
  const unique: AgentRow[] = [];
  for (const a of agents) {
    if (seenOrgs.has(a.organization_id)) continue;
    seenOrgs.add(a.organization_id);
    unique.push(a);
  }

  let totalProcessed = 0;
  let totalFlagged = 0;
  let totalSkipped = 0;
  let orgsProcessed = 0;
  const failures: string[] = [];

  for (const agent of unique) {
    try {
      const result = await ingestConversationsBatch({
        organizationId: agent.organization_id,
        agentId: agent.id,
        sinceTs,
      });
      orgsProcessed++;
      totalProcessed += result.processed;
      totalFlagged += result.flaggedReview;
      totalSkipped += result.skipped;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(
        "[kb-conversations-cron] org failed",
        agent.organization_id,
        detail,
      );
      failures.push(`${agent.organization_id}:${detail}`);
    }
  }

  // Rodada que não ingeriu, não sinalizou, não pulou e não falhou nada não é
  // mutação e não ocupa linha de auditoria (mesmo critério do snooze-watcher e
  // do recover-stuck-messages). `orgsProcessed` fica de propósito FORA da
  // condição: ele conta organizações VISITADAS, e visitar uma organização sem
  // conversa nova é exatamente o nada que esta guarda existe para não registrar.
  //
  // `failures` entra: uma rodada em que toda organização estourou tem os três
  // contadores em zero, e sem esta cláusula ficaria idêntica, na trilha, à
  // rodada de uma instalação sem conversa nenhuma.
  const houveEfeito =
    totalProcessed > 0 || totalFlagged > 0 || totalSkipped > 0 || failures.length > 0;
  if (houveEfeito) {
    await audit({
      action: "rag.conversations_batch_run",
      organizationId: null,
      metadata: {
        orgs_processed: orgsProcessed,
        total_processed: totalProcessed,
        total_flagged: totalFlagged,
        total_skipped: totalSkipped,
        failures: failures.length,
        since_ts: sinceTs.toISOString(),
      },
      requestId,
    });
  }

  return ok(
    {
      orgs_processed: orgsProcessed,
      total_processed: totalProcessed,
      total_flagged: totalFlagged,
      total_skipped: totalSkipped,
      failures,
    },
    { requestId },
  );
}
