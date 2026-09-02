/**
 * GET/POST /api/v1/cron/prune-old-media
 *
 * Regra de negócio B-03 (`docs/business-rules/00-business-rules-catalog.md`):
 * mídia do WhatsApp tem retenção configurável por organização
 * (`organizations.media_retention_days`, default 365). O campo existia desde
 * a migration original mas **nunca teve leitor**: nenhum cron aplicava o
 * corte — achado ao comparar com o changelog do upstream (DeskcommCRM 1.4.0:
 * "limpeza automática do banco... mídia depois de um período"). Toda
 * instalação acumulava mídia para sempre, risco real de estourar a cota de
 * 1 GB do bucket `whatsapp-media` num Supabase free tier.
 *
 * O que faz, e o que deliberadamente NÃO faz:
 *
 *   - para cada organização, apaga o BLOB de mídia de mensagens mais velhas
 *     que `media_retention_days`, via `storage_redaction_queue` (mesma fila
 *     que o cascade de LGPD usa — `on conflict (bucket, object_path) do
 *     nothing`, então enfileirar duas vezes o mesmo objeto é inofensivo; quem
 *     drena de verdade é o cron `storage-redaction`, já agendado);
 *   - **preserva a linha de `messages`** — corpo de texto (legenda), tipo,
 *     timestamps e toda a timeline continuam intactos; só as 4 colunas de
 *     mídia (`media_url`, `media_storage_path`, `media_mime`,
 *     `media_size_bytes`) somem. Mesmo espírito da cascata LGPD ("preserva
 *     timestamps"), aplicado aqui à cota, não a um pedido de titular;
 *   - **não decide sozinho que o objeto sumiu** — quem remove do Storage é o
 *     `storage-redaction` (retry com backoff, idempotente); este cron só
 *     ENFILEIRA e limpa as colunas da mensagem, então uma falha transitória
 *     do Storage não deixa a mensagem apontando para um blob morto: a coluna
 *     já foi zerada no mesmo passo que enfileirou a remoção.
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

/** Teto de mensagens podadas por organização, por rodada — a rodada seguinte pega o resto. */
const BATCH_PER_ORG = 200;
/** Teto de organizações processadas por rodada — bound de custo numa instalação com muitos tenants. */
const MAX_ORGS_PER_RUN = 100;

interface OrgRow {
  id: string;
  media_retention_days: number;
}

interface MessageRow {
  id: string;
  media_storage_path: string;
}

export interface PruneResult {
  organizations_scanned: number;
  messages_pruned: number;
}

/**
 * Separado do handler HTTP para o teste poder exercitar a REGRA sem montar
 * request/auth — mesmo desenho de `recoverStuckMessages`/`purgeEventLog`.
 */
export async function pruneOldMedia(
  admin: ReturnType<typeof createAdminClient>,
  now: Date,
): Promise<PruneResult> {
  const { data: orgs, error: orgsErr } = await admin
    .from("organizations")
    .select("id, media_retention_days")
    .limit(MAX_ORGS_PER_RUN);
  if (orgsErr) throw new Error(`orgs_select_failed: ${orgsErr.message}`);

  let messages_pruned = 0;
  const rows = (orgs ?? []) as OrgRow[];

  for (const org of rows) {
    const cutoff = new Date(now.getTime() - org.media_retention_days * 24 * 60 * 60 * 1000).toISOString();

    const { data: velhas, error: selErr } = await admin
      .from("messages")
      .select("id, media_storage_path")
      .eq("organization_id", org.id)
      .not("media_storage_path", "is", null)
      .lt("created_at", cutoff)
      .limit(BATCH_PER_ORG);
    if (selErr) throw new Error(`messages_select_failed(${org.id}): ${selErr.message}`);

    const velhasRows = (velhas ?? []) as MessageRow[];
    if (velhasRows.length === 0) continue;

    const { error: queueErr } = await admin
      .from("storage_redaction_queue")
      .upsert(
        velhasRows.map((m) => ({
          organization_id: org.id,
          bucket: "whatsapp-media",
          object_path: m.media_storage_path,
        })),
        { onConflict: "bucket,object_path", ignoreDuplicates: true },
      );
    if (queueErr) throw new Error(`queue_upsert_failed(${org.id}): ${queueErr.message}`);

    const { error: updErr } = await admin
      .from("messages")
      .update({
        media_url: null,
        media_storage_path: null,
        media_mime: null,
        media_size_bytes: null,
      })
      .in(
        "id",
        velhasRows.map((m) => m.id),
      );
    if (updErr) throw new Error(`messages_update_failed(${org.id}): ${updErr.message}`);

    messages_pruned += velhasRows.length;
  }

  return { organizations_scanned: rows.length, messages_pruned };
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let result: PruneResult;
  try {
    result = await pruneOldMedia(createAdminClient(), new Date());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[prune-old-media] falhou", { error: detail, requestId });
    return fail("internal_error", "Failed to prune old media.", 500, { requestId });
  }

  return ok(result, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
