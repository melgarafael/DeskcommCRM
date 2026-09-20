/**
 * GET/POST /api/v1/cron/sync-magento-catalog — atualiza `commerce_products`
 * para toda organização com integração Magento saudável.
 *
 * Entrega 3 do plano de concierge de compras Magento. Cadência sugerida:
 * algumas vezes ao dia — catálogo de loja física-para-WhatsApp não muda
 * minuto a minuto, e cada rodada é uma chamada SOAP pesada por loja (§ ver
 * `lib/commerce/sync-magento-catalog.ts`).
 *
 * Auth: mesmo contrato dos demais crons (Bearer `INTERNAL_CRON_SECRET` |
 * `INTERNAL_SECRET`, fail-closed).
 *
 * Audita SÓ quando uma organização de fato sincronizou (efeito real) — rodada
 * sem nenhuma integração saudável não escreve na trilha, mesmo padrão de
 * `routing-worker`/`attendant-heartbeat` depois do #261.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { syncMagentoCatalog } from "@/lib/commerce/sync-magento-catalog";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";

function autorizado(req: NextRequest): boolean {
  const esperado = env.INTERNAL_CRON_SECRET || env.INTERNAL_SECRET;
  if (!esperado) return false;
  return req.headers.get("authorization") === `Bearer ${esperado}`;
}

interface StoreMetadata {
  endpoint?: string;
  api_user?: string;
  primary_store_view?: string | null;
}

async function handler(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizado(req)) {
    return fail("unauthorized", "cron secret ausente ou inválido", 401, { requestId });
  }

  const admin = createAdminClient();
  const { data: integrations, error } = await admin
    .from("tenant_integrations")
    .select("id, organization_id, store_metadata, oauth_access_token_encrypted")
    .eq("provider", "magento")
    .eq("status", "healthy");

  if (error) {
    return fail("cron_failed", error.message, 500, { requestId });
  }

  let synced = 0;
  let failed = 0;
  const detalhes: Array<{ organization_id: string; fetched?: number; upserted?: number; stockSynced?: number; error?: string }> =
    [];

  for (const row of integrations ?? []) {
    const meta = row.store_metadata as StoreMetadata | null;
    if (!meta?.endpoint || !meta?.api_user) {
      failed++;
      detalhes.push({ organization_id: row.organization_id, error: "store_metadata_incompleto" });
      continue;
    }
    const apiKey = await decryptWebhookSecret(admin, row.oauth_access_token_encrypted as string);
    if (!apiKey) {
      failed++;
      detalhes.push({ organization_id: row.organization_id, error: "credencial_indecifravel" });
      continue;
    }
    try {
      const resultado = await syncMagentoCatalog(admin, {
        organizationId: row.organization_id,
        integrationId: row.id,
        // Código REAL, gravado na conexão — "default" como literal quebrava
        // shoppingCartCreate em lojas cuja store view não se chama assim
        // (achado instalando contra a loja real; ver route.ts de conexão).
        // Loja conectada antes desta correção cai no literal como último
        // recurso; reconectar grava o valor certo. Loja com mais de uma store
        // view: qual é "a principal" continua pendente (plano §13, item 2).
        storeView: meta.primary_store_view ?? "default",
        config: { endpoint: meta.endpoint, apiUser: meta.api_user, apiKey },
      });
      await admin
        .from("tenant_integrations")
        .update({ last_sync_at: new Date().toISOString() })
        .eq("id", row.id);
      synced++;
      detalhes.push({
        organization_id: row.organization_id,
        fetched: resultado.fetched,
        upserted: resultado.upserted,
        stockSynced: resultado.stockSynced,
      });
    } catch (err) {
      failed++;
      const motivo = err instanceof Error ? err.message : String(err);
      detalhes.push({ organization_id: row.organization_id, error: motivo });
      logger.error("[cron.sync-magento-catalog] falhou para organização", {
        organization_id: row.organization_id,
        error: motivo,
      });
    }
  }

  // Só audita se pelo menos uma organização de fato sincronizou — rodada sem
  // efeito nenhum (nenhuma integração saudável, ou todas falharam) não é
  // mutação.
  if (synced > 0) {
    await audit({
      action: "magento.catalog_synced",
      requestId,
      metadata: { synced, failed, total: integrations?.length ?? 0 },
    });
  }

  return ok({ synced, failed, total: integrations?.length ?? 0, detalhes }, { requestId });
}

export const GET = handler;
export const POST = handler;
