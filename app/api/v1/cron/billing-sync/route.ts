import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { ok, fail } from "@/lib/api/wrappers";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { drainCaktoBilling } from "@/lib/billing/cakto-sync";
export const dynamic = "force-dynamic";
async function handle(request: NextRequest) {
  const requestId = randomUUID();
  if (!autorizaCron(request)) return fail("forbidden", "Acesso negado.", 403, { requestId });
  if (process.env.BILLING_PROVIDER !== "cakto")
    return ok({ processed: 0, failed: 0 }, { requestId });
  try {
    return ok(await drainCaktoBilling(getRequestPool()), { requestId });
  } catch {
    return fail("service_unavailable", "Não foi possível conferir as assinaturas.", 503, {
      requestId,
    });
  }
}
export const GET = handle;
export const POST = handle;
