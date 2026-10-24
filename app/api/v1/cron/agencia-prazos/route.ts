import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { avisarPrazos } from "@/lib/agencia/tarefas/relogios";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Avisa os prazos das tarefas da agência (docs/agencia/SPEC-tarefas.md, T8): nos
 * dias de antecedência configurados, no dia e no atraso, cada marco uma vez.
 * A cada 15 min, pelo `scheduler`. Rodada que não avisou ninguém não audita.
 */
async function handle(req: NextRequest) {
  const requestId = randomUUID();
  if (!autorizaCron(req)) return fail("forbidden", "Credencial de execução inválida.", 403, { requestId });
  try {
    const r = await avisarPrazos();
    if (r.avisados > 0) {
      void audit({ action: "agencia.avisos_de_prazo_enviados", organizationId: null, metadata: { avisados: r.avisados }, requestId });
    }
    return ok(r, { requestId });
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : String(err);
    logger.error("[agencia-prazos.cron] falhou", { error: detalhe, requestId });
    return fail("internal_error", detalhe, 500, { requestId });
  }
}
export const GET = handle;
export const POST = handle;
