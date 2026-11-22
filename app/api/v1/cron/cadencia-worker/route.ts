/**
 * GET/POST /api/v1/cron/cadencia-worker — anda a fila de `email_cadence_enrollments`
 * vencidas, minuto a minuto (mesma cadência do `campaign-worker`, agendado em
 * `docker/scheduler/entrypoint.sh`).
 *
 * A regra vive em `lib/cadencias/worker.ts` (`processarCadencias`), separada
 * daqui pelo mesmo motivo de `recover-stuck-messages`: o teste exercita a
 * regra sem montar request/auth, e esta rota fica sendo só borda.
 *
 * ─── O PISO OCIOSO (#3731) ──────────────────────────────────────────────────
 *
 * Módulo de TABELA e desligado por padrão: sem a linha `cadencias` em
 * `modulos_instalados`, a rodada saía logo na primeira pergunta
 * (`moduloLigado`), mas essa pergunta custa DUAS leituras ao PostgREST
 * (`platform_config` + `modulos_instalados`) — 120 idas ao banco por hora numa
 * instalação que nunca ligou o módulo. O portão responde a mesma pergunta num
 * retrato de processo (`lib/cron/piso-ocioso.ts`, uma leitura de pool por
 * janela de 30 s, compartilhada com as outras rotas) e, desligado, a rota sai
 * antes de qualquer `from()`/`rpc()`.
 *
 * Falha do retrato = "tem trabalho": a rodada segue e a pergunta de módulo
 * acontece como antes. O portão economiza cota; não decide se a cadência
 * funciona.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|
 * INTERNAL_SECRET, fail-closed).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { processarCadencias } from "@/lib/cadencias/worker";
import { recursoOcioso } from "@/lib/cron/piso-ocioso";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Os passos de NÍVEL SUPERIOR que rodam depois do portão (#3773). O portão é
 * saída da ROTA inteira: passo novo abaixo dele nasce desligado em instalação
 * ociosa. Este teste-cerca (`tests/unit/cron-passa-pelo-portao.test.ts`) compara
 * esta lista com o arquivo.
 */
const PASSOS_DEPOIS_DO_PORTAO = [
  "let resultado",
  "try",
  "if (resultado.processadas > 0)",
  "return",
] as const;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  if (await recursoOcioso("cadencias")) return ok({ pulado: "recurso_ocioso" }, { requestId });

  let resultado;
  try {
    resultado = await processarCadencias(createAdminClient(), new Date(), requestId);
  } catch {
    logger.error("[cadencia-worker] rodada falhou", { codigo: "cadencia_tick_failed", requestId });
    return fail("internal_error", "Failed to process cadencia enrollments.", 500, { requestId });
  }

  // Rodada que não mexeu em nenhuma inscrição não é mutação e não audita —
  // mesmo critério do `recover-stuck-messages`/`data-retention` (CLAUDE.md,
  // seção de audit log).
  if (resultado.processadas > 0) {
    void audit({
      action: "cron.cadencia_worker",
      organizationId: null,
      bypassedRls: true,
      metadata: resultado as unknown as Record<string, unknown>,
      requestId,
    });
  }

  return ok(resultado, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
