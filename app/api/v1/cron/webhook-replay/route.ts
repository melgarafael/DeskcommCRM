/**
 * GET/POST /api/v1/cron/webhook-replay — a mensagem que o banco recusou por um
 * instante volta a ser tentada.
 *
 * A rota do webhook do canal por QR devolve 503 quando o banco falha de forma
 * transitória e o transporte reentrega por alguns segundos; o que não entrar
 * nessa janela fica no arquivo marcado `transitoria:`, e este cron o reprocessa
 * a cada minuto. A regra inteira (espera, teto de tentativas, desistência com
 * aviso na Central, parada na terceira falha seguida) mora em
 * `lib/channels/reprocessar-arquivo-de-webhook.ts`; aqui ficam só a
 * autenticação e a auditoria.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|
 * INTERNAL_SECRET, fail-closed). Agendado no serviço `scheduler`
 * (`docker/scheduler/entrypoint.sh`).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import {
  reprocessarArquivoDeWebhooks,
  type ResultadoDoReplay,
} from "@/lib/channels/reprocessar-arquivo-de-webhook";
import { MOTIVO_DO_PULO, recursoLigado } from "@/lib/cron/recursos-ligados";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();

  // #3694: sem NENHUMA linha transitória no arquivo, a rodada saía vazia em
  // 143 de 144 tiques (medido na issue). A leitura compartilhada responde isso
  // sem trazer as 50 linhas com `payload_parsed` que o replay carrega. A sonda
  // é um SUPERCONJUNTO do filtro daqui (não aplica o corte de `ESPERA_MS`), de
  // propósito: linha recém-arquivada nunca fica invisível para o replay.
  if (!(await recursoLigado(admin, "webhook_replay"))) {
    return ok(
      { lidas: 0, processadas: 0, ainda_falhando: 0, desistidas: 0, pulado: MOTIVO_DO_PULO },
      { requestId },
    );
  }

  let result: ResultadoDoReplay;
  try {
    result = await reprocessarArquivoDeWebhooks(admin, new Date(), requestId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[webhook-replay] falhou", { error: detail, requestId });
    return fail("internal_error", "Failed to replay webhooks.", 500, { requestId });
  }

  // Rodada que não reprocessou nem desistiu de nada não é mutação e não audita.
  if (result.processadas + result.desistidas > 0) {
    void audit({
      action: "webhook.replay_run",
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
