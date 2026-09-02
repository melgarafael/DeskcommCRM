/**
 * GET/POST /api/v1/cron/event-log-purge
 *
 * `event_log` (o "bus interno" — todo trigger e Server Action emite aqui via
 * `emit_event()`) nunca tinha limpeza: `lib/event-log/drain.ts` só faz
 * `UPDATE status='done'|'dead'`, a linha nunca é removida. Achado ao comparar
 * com o changelog do upstream (DeskcommCRM 1.4.0): "limpeza automática do
 * banco — eventos brutos de WhatsApp apagados depois de um período". Sem
 * nenhum cron de purge, a tabela cresce para sempre em toda instalação — risco
 * real de estourar cota de disco num Supabase free tier, que é um cenário real
 * de self-host.
 *
 * O que este cron faz, e o que deliberadamente NÃO faz:
 *
 *   - apaga linhas com `status IN ('done','dead')` cujo `updated_at` (o
 *     instante em que ENTROU nesse estado terminal, não `created_at`) é mais
 *     velho que o corte da categoria;
 *   - corte MAIS CURTO para `done` (processado com sucesso — nada a
 *     investigar) e MAIS LONGO para `dead` (esgotou retries; alguém pode
 *     precisar olhar `last_error` antes de perder o registro);
 *   - **nunca toca `pending`/`processing`** — esses estados têm dono (o
 *     drain reagenda), e apagá-los perderia evento que ainda vai acontecer;
 *   - não emite evento nenhum: apagar uma linha JÁ processada não é fato de
 *     negócio, é limpeza de infraestrutura — emitir aqui criaria um
 *     `event_log.*` que o próprio purge teria de purgar depois.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|
 * INTERNAL_SECRET, fail-closed).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** `done`: processado com sucesso, nada a investigar depois disso. */
export const DONE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** `dead`: esgotou retries — mais tempo para alguém ler `last_error` antes de perder o registro. */
export const DEAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Teto por invocação e por status — a rodada seguinte pega o resto. */
const DELETE_BATCH = 1000;

export interface PurgeResult {
  deleted_done: number;
  deleted_dead: number;
}

/**
 * Separado do handler HTTP para o teste poder exercitar a REGRA sem montar
 * request/auth — mesmo desenho de `recoverStuckMessages`.
 */
/**
 * Apaga um lote de `event_log` num status terminal, mais velho que `cutoff`.
 *
 * DUAS chamadas, não uma `DELETE ... LIMIT`: PostgREST não aceita `limit`/
 * `order` em mutação (só em SELECT) — Postgres puro também não tem `DELETE
 * ... LIMIT` sem subquery. O `SELECT id ... LIMIT` primeiro é o que faz o
 * teto por rodada valer sem depender de um recurso que a camada HTTP não tem.
 */
async function purgeBatch(
  admin: ReturnType<typeof createAdminClient>,
  status: "done" | "dead",
  cutoffIso: string,
): Promise<number> {
  const { data: alvo, error: selErr } = await admin
    .from("event_log")
    .select("id")
    .eq("status", status)
    .lt("updated_at", cutoffIso)
    .limit(DELETE_BATCH);
  if (selErr) throw new Error(`purge_${status}_select_failed: ${selErr.message}`);

  const ids = (alvo ?? []).map((r: { id: string }) => r.id);
  if (ids.length === 0) return 0;

  const { error: delErr } = await admin.from("event_log").delete().in("id", ids);
  if (delErr) throw new Error(`purge_${status}_delete_failed: ${delErr.message}`);

  return ids.length;
}

export async function purgeEventLog(
  admin: ReturnType<typeof createAdminClient>,
  now: Date,
): Promise<PurgeResult> {
  const doneCutoff = new Date(now.getTime() - DONE_RETENTION_MS).toISOString();
  const deadCutoff = new Date(now.getTime() - DEAD_RETENTION_MS).toISOString();

  const deleted_done = await purgeBatch(admin, "done", doneCutoff);
  const deleted_dead = await purgeBatch(admin, "dead", deadCutoff);

  return { deleted_done, deleted_dead };
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let result: PurgeResult;
  try {
    result = await purgeEventLog(createAdminClient(), new Date());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[event-log-purge] falhou", { error: detail, requestId });
    return fail("internal_error", "Failed to purge event_log.", 500, { requestId });
  }

  return ok(result, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
