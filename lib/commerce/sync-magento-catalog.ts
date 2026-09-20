/**
 * Sincroniza `commerce_products` a partir do catálogo Magento (Entrega 3 do
 * plano de concierge de compras, §6.2).
 *
 * `catalogProductList` não pagina — devolve o catálogo inteiro numa chamada
 * (medido contra a loja real: 6.478 produtos, ~2.4 MB de resposta). Por isso
 * este sync só grava o que a LISTA traz (nome, SKU, tipo, categorias): rodar
 * `catalogProductInfo` (preço, descrição) para cada um dos 6 mil produtos a
 * cada sincronização seria minutos de chamadas sequenciais para um cache de
 * BUSCA que nunca decide venda sozinho (plano §6.1 — preço/estoque efetivos
 * são revalidados ao vivo antes de confirmar seleção, não nesta tabela).
 * Detalhe completo fica para quando o produto é efetivamente apresentado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import {
  withMagentoSession,
  magentoListProducts,
  magentoGetStock,
  type MagentoConnectionConfig,
} from "@/lib/magento/soap";

export interface SyncMagentoCatalogInput {
  organizationId: string;
  integrationId: string;
  storeView: string;
  config: MagentoConnectionConfig;
}

export interface SyncMagentoCatalogResult {
  fetched: number;
  upserted: number;
  /** Linhas cujo estoque foi relido nesta rodada (pode ser < upserted se o orçamento de tempo acabou). */
  stockSynced: number;
}

// Medido contra a loja real: 500 ids em ~4,8 s (6,4 mil produtos ≈ 13 lotes ≈ 65 s).
// O agendador dá 120 s à rodada inteira, então o estoque roda com orçamento próprio e
// para limpo; as linhas mais antigas vão primeiro na rodada seguinte.
const STOCK_BATCH = 500;
const STOCK_BUDGET_MS = 60_000;

export async function syncMagentoCatalog(
  admin: SupabaseClient,
  input: SyncMagentoCatalogInput,
): Promise<SyncMagentoCatalogResult> {
  const list = await withMagentoSession(input.config, (sessionId) =>
    magentoListProducts(input.config, sessionId, input.storeView),
  );

  const rows = list
    .filter((p) => p.productId !== "" && p.sku !== "")
    .map((p) => ({
      organization_id: input.organizationId,
      integration_id: input.integrationId,
      store_view: input.storeView,
      external_id: p.productId,
      sku: p.sku,
      type: p.type,
      name: p.name,
      synced_at: new Date().toISOString(),
    }));

  // Lotes de 500: um único upsert com 6 mil linhas é uma só transação enorme
  // e um payload HTTP grande; lotes deixam falha parcial recuperável (a
  // próxima rodada recobre o resto) sem reprocessar o catálogo inteiro.
  let upserted = 0;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await admin
      .from("commerce_products")
      .upsert(batch, { onConflict: "organization_id,integration_id,store_view,external_id" });
    if (error) {
      logger.error("[commerce.sync-magento] lote falhou", {
        error: error.message,
        batch_start: i,
        organization_id: input.organizationId,
      });
      throw new Error(`commerce_products_upsert_failed: ${error.message}`);
    }
    upserted += batch.length;
  }

  const stockSynced = await syncMagentoStock(admin, input);

  return { fetched: list.length, upserted, stockSynced };
}

/**
 * Relê `is_in_stock`/`qty` de cada produto. Falha aqui NUNCA derruba o sync do
 * catálogo: estoque NULL significa "desconhecido" e a busca trata como
 * disponível — a conferência ao vivo em `present_product` continua sendo a trava.
 * Mais antigo primeiro (`stock_synced_at` nulo vai na frente), para que um orçamento
 * de tempo curto ainda cubra o catálogo inteiro ao longo das rodadas.
 */
async function syncMagentoStock(admin: SupabaseClient, input: SyncMagentoCatalogInput): Promise<number> {
  const deadline = Date.now() + STOCK_BUDGET_MS;
  type Linha = { external_id: string; sku: string; type: string; name: string };
  const linhas: Linha[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("commerce_products")
      .select("external_id, sku, type, name")
      .eq("organization_id", input.organizationId)
      .eq("integration_id", input.integrationId)
      .eq("store_view", input.storeView)
      .order("stock_synced_at", { ascending: true, nullsFirst: true })
      .order("external_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      logger.warn("[commerce.sync-magento] estoque: leitura das linhas falhou", { error: error.message });
      return 0;
    }
    linhas.push(...((data ?? []) as Linha[]));
    if (!data || data.length < PAGE) break;
  }

  let synced = 0;
  for (let i = 0; i < linhas.length && Date.now() < deadline; i += STOCK_BATCH) {
    const lote = linhas.slice(i, i + STOCK_BATCH);
    try {
      const estoque = await withMagentoSession(input.config, (sessionId) =>
        magentoGetStock(input.config, sessionId, lote.map((l) => l.external_id)),
      );
      const porId = new Map(estoque.map((e) => [e.productId, e]));
      const agora = new Date().toISOString();
      const rows = lote.flatMap((l) => {
        const e = porId.get(l.external_id);
        // Sem linha de estoque para o id = a loja não gerencia estoque dele: desconhecido, não "zerado".
        if (!e) return [];
        return [
          {
            organization_id: input.organizationId,
            integration_id: input.integrationId,
            store_view: input.storeView,
            external_id: l.external_id,
            sku: l.sku,
            type: l.type,
            name: l.name,
            is_in_stock: e.isInStock,
            stock_qty: Number.isFinite(Number(e.qty)) ? Number(e.qty) : null,
            stock_synced_at: agora,
          },
        ];
      });
      if (rows.length === 0) continue;
      const { error } = await admin
        .from("commerce_products")
        .upsert(rows, { onConflict: "organization_id,integration_id,store_view,external_id" });
      if (error) {
        logger.warn("[commerce.sync-magento] estoque: lote não gravou", { error: error.message, lote_inicio: i });
        continue;
      }
      synced += rows.length;
    } catch (err) {
      logger.warn("[commerce.sync-magento] estoque: lote falhou", {
        error: err instanceof Error ? err.message : String(err),
        lote_inicio: i,
      });
    }
  }
  return synced;
}
