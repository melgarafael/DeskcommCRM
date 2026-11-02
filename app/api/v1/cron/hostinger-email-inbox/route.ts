import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncHostingerInboxes } from "@/lib/email/hostinger-inbox-sync";

export const dynamic = "force-dynamic";

async function handle(request: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(request)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  try {
    const counts = await syncHostingerInboxes(createAdminClient());
    return ok(counts, { requestId });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split(":").at(0) ?? "email_sync_failed" : "email_sync_failed";
    logger.error("[hostinger-email-inbox] rodada falhou", { requestId, detail });
    return fail("internal_error", detail, 500, { requestId });
  }
}

export const POST = handle;
