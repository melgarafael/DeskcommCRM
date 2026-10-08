import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { processarLembretesTarefa } from "@/lib/escalacao/lembretes-tarefa";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req))
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  try {
    const avisados = await processarLembretesTarefa(createAdminClient());
    if (avisados > 0) {
      await audit({
        action: "ai.caso_lembrete_cobrado",
        resourceType: "agent_case",
        requestId,
        metadata: { avisados },
      });
    }
    return ok({ avisados }, { requestId });
  } catch (err) {
    logger.error("[case-task-reminders] cobrança falhou", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail("internal_error", "Falha ao atualizar lembretes de casos.", 500, { requestId });
  }
}

export const GET = handle;
export const POST = handle;
