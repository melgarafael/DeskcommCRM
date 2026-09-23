/**
 * GET /api/v1/cron/storage-redaction
 *
 * Drains the LGPD `storage_redaction_queue` (one batch per call). Designed
 * to run from a scheduled cron (Vercel Cron / external cron) every few
 * minutes. Idempotent: rows transition pending → deleted | failed | skipped.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (fail-closed when
 * secret missing). Mirrors `app/api/v1/cron/kb-conversations-batch/route.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { drainStorageRedactionQueue } from "@/lib/lgpd/storage-redaction-queue";
import { autorizaCron } from "@/lib/auth/cron-auth";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const url = new URL(req.url);
  const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, MAX_LIMIT)
      : DEFAULT_LIMIT;

  const stats = await drainStorageRedactionQueue({ limit });

  return ok(stats, { requestId });
}
