/**
 * GET/POST /api/v1/cron/event-log-drain
 *
 * Cron entry point for the generic event_log drain (Task 2, spec
 * webhooks/automação 2026-07-17), scheduled by the `scheduler` service
 * (`docker/scheduler/entrypoint.sh`). Each tick drains up to 50 `pending` rows
 * whose `event_type` has a handler registered via `ensureHandlersRegistered()`
 * — types drained by a dedicated cron (e.g. `ai_agent.dispatch_requested` →
 * agent-dispatcher) have no handler here and are left untouched.
 *
 * Auth: header `Authorization: Bearer <INTERNAL_CRON_SECRET>` (preferred) or
 * `<INTERNAL_SECRET>` (fallback), same pattern as agent-dispatcher. The
 * X-Cron-Secret header is also accepted as alias.
 *
 * ─── UM DRENO POR VEZ (issue #2235) ──────────────────────────────────────────
 *
 * A MESMA rota é armada por dois agendadores na mesma instalação: o cron do
 * contêiner (`docker/scheduler/entrypoint.sh:59`) e o crontab do host que o kit
 * grava (`hostgator-setup-kit/_common.sh`, `setup_event_log_drain_cron`). Em vez
 * de escolher um (o `update.sh` recoloca a linha do host, e o worker depende do
 * cron como rede de segurança), a passada é serializada por uma trava de
 * sessão no BANCO — ver `lib/event-log/trava-do-dreno.ts` para o porquê do
 * banco, do lock de sessão e do 200.
 *
 * Contrato preservado: mesma rota, mesma auth, mesmo 200 no caso normal. Quem
 * chega enquanto outra passada drena recebe `200 { data: { ok: true, pulado:
 * "outro_dreno" } }` e NÃO toca a fila. 409 quebraria os dois crons, que tratam
 * qualquer não-2xx como falha.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import { drenarSozinho } from "@/lib/event-log/trava-do-dreno";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";
import { logger } from "@/lib/logger";
import { autorizaCron } from "@/lib/auth/cron-auth";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  ensureHandlersRegistered();
  try {
    // 200 também quando outra passada está drenando (`pulado: "outro_dreno"`):
    // os dois crons tratam não-2xx como falha. Ver `trava-do-dreno.ts`.
    const resumo = await drenarSozinho(createAdminClient());
    return ok(resumo, { requestId });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[event-log-drain.cron] threw", { error: detail, requestId });
    return fail("internal_error", detail, 500, { requestId });
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
