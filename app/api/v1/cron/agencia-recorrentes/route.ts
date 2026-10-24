import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { gerarRecorrentes } from "@/lib/agencia/tarefas/relogios";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Gera as tarefas recorrentes vencidas da área da agência (docs/agencia/SPEC-tarefas.md, T9–T10).
 * De hora em hora, pelo `scheduler`. Rodada que não gerou nada não audita.
 */
async function handle(req: NextRequest) {
  const requestId = randomUUID();
  if (!autorizaCron(req)) return fail("forbidden", "Credencial de execução inválida.", 403, { requestId });
  try {
    const r = await gerarRecorrentes();
    if (r.geradas > 0) {
      void audit({ action: "agencia.recorrentes_geradas", organizationId: null, metadata: { geradas: r.geradas }, requestId });
    }
    return ok(r, { requestId });
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : String(err);
    logger.error("[agencia-recorrentes.cron] falhou", { error: detalhe, requestId });
    return fail("internal_error", detalhe, 500, { requestId });
  }
}
export const GET = handle;
export const POST = handle;
