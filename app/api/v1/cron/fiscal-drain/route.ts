/**
 * POST /api/v1/cron/fiscal-drain — um tick da fila fiscal.
 *
 * Mesmo molde do prospecting-drain: Bearer INTERNAL_CRON_SECRET (ou
 * INTERNAL_SECRET), admin client, resumo JSON. Reclama até 5 jobs vencidos
 * por tick (cada emissão pode levar 2 min na SEFAZ) e processa em sequência.
 * Chamado a cada 2 min pelo scheduler da VPS; em dev, `pnpm dev:crons`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { processarJob, type JobFiscal } from "@/lib/fiscal/drain";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const JOBS_POR_TICK = 2;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const headerSecret = req.headers.get("x-cron-secret")?.trim() ?? "";
  const provided = bearer || headerSecret;

  const accepted: string[] = [];
  if (env.INTERNAL_CRON_SECRET) accepted.push(env.INTERNAL_CRON_SECRET);
  if (env.INTERNAL_SECRET) accepted.push(env.INTERNAL_SECRET);

  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("fiscal_jobs")
      .select("id, organization_id, invoice_id, tentativas, max_tentativas")
      .eq("status", "pendente")
      .lte("proxima_tentativa", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(JOBS_POR_TICK);
    const jobs = (data ?? []) as unknown as JobFiscal[];
    const saidas: Record<string, number> = { concluido: 0, reagendado: 0, ignorado: 0 };
    for (const job of jobs) {
      const r = await processarJob(admin, job);
      saidas[r.saidas] = (saidas[r.saidas] ?? 0) + 1;
    }
    return ok({ jobs: jobs.length, ...saidas }, { requestId });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[fiscal-drain.cron] threw", { error: detail, requestId });
    return fail("internal_error", detail, 500, { requestId });
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
