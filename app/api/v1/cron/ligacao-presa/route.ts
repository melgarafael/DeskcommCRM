/**
 * GET/POST /api/v1/cron/ligacao-presa — issue #3977.
 *
 * A ligação que perde o evento de queda fica `ringing`/`starting` para sempre.
 * Ela sai por PRAZO, com o motivo gravado, e a primeira rodada depois da
 * atualização destrava de graça as linhas que já estavam presas nas instalações
 * (nada a fazer à mão pelo operador).
 *
 * Este arquivo é só a BORDA: autenticação, piso de ociosidade quando houver,
 * auditoria condicional e tradução de erro. A regra — recorte por estado e
 * idade, o `end_reason`, o claim atômico — mora em
 * `lib/voice/ligacao-presa.ts`, com o cabeçalho que explica o prazo.
 *
 * Auth: mesmo contrato dos demais crons (`autorizaCron` — Bearer
 * INTERNAL_CRON_SECRET|INTERNAL_SECRET, fail-closed, comparação em tempo
 * constante). Varredura sem o segredo é recusada com 403, como as irmãs.
 *
 * NOTA DE DEPLOY: o agendamento vive no serviço `scheduler` do
 * `docker-compose.prod.yml`, cuja lista de crons está em
 * `docker/scheduler/entrypoint.sh` (o `command:` inline do compose foi
 * substituído; `tests/unit/cron-routes-scheduled.test.ts` compara a lista com
 * este diretório e reprova rota criada sem linha no crontab).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { encerrarLigacoesPresas, type ResultadoDaVarredura } from "@/lib/voice/ligacao-presa";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let result: ResultadoDaVarredura;
  try {
    result = await encerrarLigacoesPresas(createAdminClient(), new Date(), requestId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[ligacao-presa] falhou", { error: detail, requestId });
    return fail("internal_error", "Failed to recover stuck voice calls.", 500, { requestId });
  }

  // Varredura que não encerrou nada não é mutação e não ocupa linha de
  // auditoria (mesmo critério do recover-stuck-messages e do snooze-watcher).
  // Numa instalação saudável esta rota roda 288×/dia e nunca escreve.
  if (result.encerradas > 0) {
    void audit({
      action: "voice.recover_stuck_run",
      organizationId: null,
      bypassedRls: true,
      metadata: result as unknown as Record<string, unknown>,
      requestId,
    });
  }

  return ok(result, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
