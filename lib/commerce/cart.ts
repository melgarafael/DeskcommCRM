/**
 * Executor comercial (Entrega 5 do plano de concierge de compras Magento,
 * §7.2): valida/mutação DETERMINÍSTICA de carrinho, chamada pelo harness a
 * partir da intenção estruturada do modelo — não fala com o cliente (isso é
 * `send_message`, depois de o modelo ler o resultado desta chamada).
 *
 * Magento é a fonte de verdade do quote (plano §5.3): toda mutação relê o
 * carrinho no Magento logo em seguida e devolve o snapshot fresco — nunca o
 * valor que o chamador pediu. `commerce_carts` é só cache de leitura.
 *
 * Idempotência via `commerce_operations` (ledger da Entrega 2): a chave é
 * derivada de (jobId, operação, input canônico) — não pedida ao modelo, que
 * não tem por que gerenciar UUID de retry. Duas chamadas GENUINAMENTE
 * diferentes com o mesmo input no mesmo turno colidem como "operação
 * conflitante"; é um corte deliberado (ponytail) — upgrade só se medir que
 * isso acontece na prática.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  withMagentoSession,
  magentoCreateCart,
  magentoCartAddItems,
  magentoCartUpdateItems,
  magentoCartRemoveItems,
  magentoCartInfo,
  magentoCartTotals,
  MagentoSoapError,
  type MagentoConnectionConfig,
  type MagentoCartSnapshot,
  type MagentoCartTotal,
} from "@/lib/magento/soap";

export class CommerceCartError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "produto_nao_encontrado_no_catalogo"
      | "carrinho_nao_encontrado"
      | "carrinho_nao_esta_aberto"
      | "operacao_conflitante"
      | "modulo_nao_configurado"
      | "link_de_recuperacao_falhou"
      | "nenhum_item_incluido"
      | "carrinho_vazio",
  ) {
    super(message);
    this.name = "CommerceCartError";
  }
}

export interface CartExecutorContext {
  organizationId: string;
  integrationId: string;
  conversationId: string;
  storeView: string;
  config: MagentoConnectionConfig;
  /** Estável por turno do agente (job.id) — base da chave de idempotência. */
  jobId: string;
}

export interface CartLineItem {
  externalId: string;
  sku: string;
  name: string;
  qty: number;
  priceCents: number | null;
  rowTotalCents: number | null;
}

export interface CartSnapshot {
  cartId: string;
  externalQuoteId: string;
  status: "open" | "converted" | "expired";
  items: CartLineItem[];
  subtotalCents: number | null;
  grandTotalCents: number | null;
  currency: string | null;
}

function toCents(amount: number | null): number | null {
  return amount === null || Number.isNaN(amount) ? null : Math.round(amount * 100);
}

function findTotal(totals: MagentoCartTotal[], pattern: RegExp): number | null {
  return totals.find((t) => pattern.test(t.title))?.amount ?? null;
}

function snapshotFromRow(row: {
  id: string;
  external_quote_id: string;
  status: string;
  items: unknown;
  subtotal_cents: number | null;
  grand_total_cents: number | null;
  currency: string | null;
}): CartSnapshot {
  return {
    cartId: row.id,
    externalQuoteId: row.external_quote_id,
    status: row.status as CartSnapshot["status"],
    items: (row.items as CartLineItem[] | null) ?? [],
    subtotalCents: row.subtotal_cents,
    grandTotalCents: row.grand_total_cents,
    currency: row.currency,
  };
}

async function readMagentoCart(
  ctx: CartExecutorContext,
  quoteId: string,
): Promise<{ info: MagentoCartSnapshot; totals: MagentoCartTotal[] }> {
  return withMagentoSession(ctx.config, async (sessionId) => {
    const info = await magentoCartInfo(ctx.config, sessionId, quoteId, ctx.storeView);
    const totals = await magentoCartTotals(ctx.config, sessionId, quoteId, ctx.storeView);
    return { info, totals };
  });
}

async function persistSnapshot(
  admin: SupabaseClient,
  ctx: CartExecutorContext,
  cartRowId: string | null,
  quoteId: string,
): Promise<CartSnapshot> {
  const { info, totals } = await readMagentoCart(ctx, quoteId);
  const row = {
    organization_id: ctx.organizationId,
    integration_id: ctx.integrationId,
    conversation_id: ctx.conversationId,
    store_view: ctx.storeView,
    external_quote_id: quoteId,
    status: "open" as const,
    items: info.items.map((it) => ({
      externalId: it.productId,
      sku: it.sku,
      name: it.name,
      qty: it.qty,
      priceCents: toCents(it.price),
      rowTotalCents: toCents(it.rowTotal),
    })),
    subtotal_cents: toCents(findTotal(totals, /^subtotal$/i)),
    grand_total_cents: toCents(findTotal(totals, /grand total/i)),
    currency: info.currency,
    last_synced_at: new Date().toISOString(),
  };

  const query = cartRowId
    ? admin.from("commerce_carts").update(row).eq("id", cartRowId)
    : admin.from("commerce_carts").insert(row);
  const { data, error } = await query
    .select("id, external_quote_id, status, items, subtotal_cents, grand_total_cents, currency")
    .single();
  if (error || !data) {
    throw new Error(`commerce_carts_upsert_failed: ${error?.message ?? "sem retorno"}`);
  }
  return snapshotFromRow(data);
}

/** Chave determinística por (turno, operação, input canônico) — ver doc do módulo. */
function ledgerKey(jobId: string, operation: string, input: unknown): string {
  return createHash("sha256").update(`${jobId}:${operation}:${JSON.stringify(input)}`).digest("hex");
}

async function withLedger<T>(
  admin: SupabaseClient,
  args: { organizationId: string; integrationId: string; operation: string; jobId: string; input: unknown },
  run: () => Promise<T>,
): Promise<T> {
  const operationId = ledgerKey(args.jobId, args.operation, args.input);
  const inputHash = createHash("sha256").update(JSON.stringify(args.input)).digest("hex");

  const { data: existing } = await admin
    .from("commerce_operations")
    .select("status, input_hash, result")
    .eq("integration_id", args.integrationId)
    .eq("operation", args.operation)
    .eq("operation_id", operationId)
    .maybeSingle();

  if (existing) {
    if (existing.input_hash !== inputHash) {
      throw new CommerceCartError(
        "operação conflitante: outra chamada com dados diferentes já está em curso para este mesmo pedido — releia o carrinho antes de tentar de novo",
        "operacao_conflitante",
      );
    }
    if (existing.status === "succeeded") return existing.result as T;
    throw new CommerceCartError(
      "operação equivalente ainda em andamento ou falhou — releia o carrinho antes de repetir",
      "operacao_conflitante",
    );
  }

  const { error: insertError } = await admin.from("commerce_operations").insert({
    organization_id: args.organizationId,
    integration_id: args.integrationId,
    operation: args.operation,
    operation_id: operationId,
    input_hash: inputHash,
    status: "pending",
  });
  if (insertError) {
    // 23505: corrida com outra chamada idêntica concorrente — mesmo tratamento.
    throw new CommerceCartError(
      "operação concorrente equivalente em curso — releia o carrinho antes de repetir",
      "operacao_conflitante",
    );
  }

  try {
    const result = await run();
    await admin
      .from("commerce_operations")
      .update({ status: "succeeded", result: result as object })
      .eq("integration_id", args.integrationId)
      .eq("operation", args.operation)
      .eq("operation_id", operationId);
    return result;
  } catch (err) {
    await admin
      .from("commerce_operations")
      .update({
        status: "failed",
        result: { error: err instanceof Error ? err.message : String(err) },
      })
      .eq("integration_id", args.integrationId)
      .eq("operation", args.operation)
      .eq("operation_id", operationId);
    throw err;
  }
}

async function requireCartRow(
  admin: SupabaseClient,
  ctx: CartExecutorContext,
  cartId: string,
): Promise<{ id: string; external_quote_id: string; status: string; items?: unknown }> {
  const { data } = await admin
    .from("commerce_carts")
    .select("id, external_quote_id, status, items")
    .eq("id", cartId)
    .eq("organization_id", ctx.organizationId)
    .eq("integration_id", ctx.integrationId)
    .eq("conversation_id", ctx.conversationId)
    .maybeSingle();
  if (!data) {
    throw new CommerceCartError("carrinho não encontrado nesta conversa", "carrinho_nao_encontrado");
  }
  return data;
}

function requireOpen(row: { status: string }): void {
  if (row.status !== "open") {
    throw new CommerceCartError(
      "este carrinho não está mais aberto (convertido em pedido ou expirado) — crie um novo",
      "carrinho_nao_esta_aberto",
    );
  }
}

/**
 * Valida que todo `externalId` já apareceu no cache de busca desta integração — nunca confia
 * em id do modelo. Devolve `externalId → nome` para o relatório de itens recusados.
 */
async function assertKnownProducts(
  admin: SupabaseClient,
  ctx: CartExecutorContext,
  externalIds: string[],
): Promise<Map<string, string>> {
  const { data } = await admin
    .from("commerce_products")
    .select("external_id, name")
    .eq("organization_id", ctx.organizationId)
    .eq("integration_id", ctx.integrationId)
    .in("external_id", externalIds);
  const nomes = new Map((data ?? []).map((r) => [r.external_id as string, (r.name as string | null) ?? ""]));
  const unknown = externalIds.filter((id) => !nomes.has(id));
  if (unknown.length > 0) {
    throw new CommerceCartError(
      `produto(s) fora do catálogo importado desta loja: ${unknown.join(", ")} — busque de novo antes de incluir`,
      "produto_nao_encontrado_no_catalogo",
    );
  }
  return nomes;
}

/** `commerce_get_cart`: lê o carrinho ABERTO desta conversa, criando um novo quote se não existir. */
export async function getOrCreateCart(admin: SupabaseClient, ctx: CartExecutorContext): Promise<CartSnapshot> {
  const { data: existing } = await admin
    .from("commerce_carts")
    .select("id, external_quote_id")
    .eq("organization_id", ctx.organizationId)
    .eq("integration_id", ctx.integrationId)
    .eq("conversation_id", ctx.conversationId)
    .eq("status", "open")
    .maybeSingle();

  if (existing) {
    return persistSnapshot(admin, ctx, existing.id, existing.external_quote_id);
  }

  return withLedger(
    admin,
    {
      organizationId: ctx.organizationId,
      integrationId: ctx.integrationId,
      operation: "cart.create",
      jobId: ctx.jobId,
      input: { conversationId: ctx.conversationId },
    },
    async () => {
      const quoteId = await withMagentoSession(ctx.config, (sessionId) =>
        magentoCreateCart(ctx.config, sessionId, ctx.storeView),
      );
      return persistSnapshot(admin, ctx, null, quoteId);
    },
  );
}

export interface CartLineRequest {
  externalId: string;
  qty: number;
}

export interface CartLineRefused {
  externalId: string;
  name: string | null;
  /** Mensagem da própria loja (ex.: "Este produto está sem estoque no momento."). */
  reason: string;
}

export interface AddItemsResult extends CartSnapshot {
  /** Linhas que a loja recusou. Vazio = tudo entrou. */
  refused: CartLineRefused[];
}

/** A loja respondeu com fault (regra dela, ex.: sem estoque). Rede/parse NÃO é recusa — propaga. */
function isStoreRefusal(err: unknown): err is MagentoSoapError {
  return err instanceof MagentoSoapError && err.code === "soap_fault";
}

/**
 * `commerce_add_items`: inclui linhas aceitas pelo cliente.
 *
 * O `shoppingCartProductAdd` do Magento valida o lote inteiro e só grava se TODAS as linhas
 * passarem — uma sem estoque recusava as outras (20/09/2026: 2 de 4 rendas sem estoque, carrinho
 * ficou vazio). Como a recusa não persiste nada, repetir linha a linha depois dela não duplica
 * quantidade. Caminho feliz continua sendo UMA chamada; só cai no item-a-item quando a loja recusa.
 * Entram os que puderem, e `refused` diz quais ficaram de fora e por quê — o agente precisa disso
 * para falar com o cliente. Só falha inteiro quando NADA entrou.
 */
export async function addItems(
  admin: SupabaseClient,
  ctx: CartExecutorContext,
  cartId: string,
  items: CartLineRequest[],
): Promise<AddItemsResult> {
  const row = await requireCartRow(admin, ctx, cartId);
  requireOpen(row);
  const nomes = await assertKnownProducts(admin, ctx, items.map((it) => it.externalId));

  return withLedger(
    admin,
    {
      organizationId: ctx.organizationId,
      integrationId: ctx.integrationId,
      operation: "cart.add_items",
      jobId: ctx.jobId,
      input: { cartId, items },
    },
    async () => {
      const refused: CartLineRefused[] = [];
      const recusar = (it: CartLineRequest, err: MagentoSoapError) =>
        refused.push({ externalId: it.externalId, name: nomes.get(it.externalId) || null, reason: err.message });

      await withMagentoSession(ctx.config, async (sessionId) => {
        const add = (lote: CartLineRequest[]) =>
          magentoCartAddItems(
            ctx.config,
            sessionId,
            row.external_quote_id,
            lote.map((it) => ({ productId: it.externalId, qty: it.qty })),
            ctx.storeView,
          );
        try {
          await add(items);
        } catch (err) {
          if (!isStoreRefusal(err)) throw err;
          if (items.length === 1) return void recusar(items[0]!, err);
          for (const it of items) {
            try {
              await add([it]);
            } catch (e) {
              if (!isStoreRefusal(e)) throw e;
              recusar(it, e);
            }
          }
        }
      });

      if (refused.length === items.length) {
        const detalhe = refused
          .map((r) => `${r.name ?? r.externalId}: ${r.reason.replace(/\s+/g, " ").trim()}`)
          .join(" | ");
        throw new CommerceCartError(`a loja recusou todos os itens — ${detalhe}`, "nenhum_item_incluido");
      }
      const snapshot = await persistSnapshot(admin, ctx, row.id, row.external_quote_id);
      return { ...snapshot, refused };
    },
  );
}

/** `commerce_update_item`: define a quantidade FINAL desejada de uma linha (absoluta — retry nunca dobra). */
export async function updateItem(
  admin: SupabaseClient,
  ctx: CartExecutorContext,
  cartId: string,
  externalId: string,
  qty: number,
): Promise<CartSnapshot> {
  const row = await requireCartRow(admin, ctx, cartId);
  requireOpen(row);
  await assertKnownProducts(admin, ctx, [externalId]);

  return withLedger(
    admin,
    {
      organizationId: ctx.organizationId,
      integrationId: ctx.integrationId,
      operation: "cart.update_item",
      jobId: ctx.jobId,
      input: { cartId, externalId, qty },
    },
    async () => {
      await withMagentoSession(ctx.config, (sessionId) =>
        magentoCartUpdateItems(ctx.config, sessionId, row.external_quote_id, [{ productId: externalId, qty }], ctx.storeView),
      );
      return persistSnapshot(admin, ctx, row.id, row.external_quote_id);
    },
  );
}

/** `commerce_remove_item`: remove uma linha do carrinho. */
export async function removeItem(
  admin: SupabaseClient,
  ctx: CartExecutorContext,
  cartId: string,
  externalId: string,
): Promise<CartSnapshot> {
  const row = await requireCartRow(admin, ctx, cartId);
  requireOpen(row);

  return withLedger(
    admin,
    {
      organizationId: ctx.organizationId,
      integrationId: ctx.integrationId,
      operation: "cart.remove_item",
      jobId: ctx.jobId,
      input: { cartId, externalId },
    },
    async () => {
      await withMagentoSession(ctx.config, (sessionId) =>
        magentoCartRemoveItems(ctx.config, sessionId, row.external_quote_id, [{ productId: externalId }], ctx.storeView),
      );
      return persistSnapshot(admin, ctx, row.id, row.external_quote_id);
    },
  );
}

export interface CheckoutLink {
  url: string;
  expiresAt: string;
}

/**
 * `commerce_create_checkout_link`: pede ao módulo Magento (Entrega 1,
 * `Deskcomm_Concierge`) um link de recuperação de UM USO para o quote atual.
 * Exige o secret opcional configurado na integração — sem ele, a loja não tem
 * o módulo instalado/configurado e a tool recusa com erro de ensino.
 */
export async function createCheckoutLink(
  admin: SupabaseClient,
  ctx: CartExecutorContext,
  cartId: string,
  moduleSecret: string | null,
): Promise<CheckoutLink> {
  const row = await requireCartRow(admin, ctx, cartId);
  requireOpen(row);
  // Só um cache vazio CONFIRMADO recusa (undefined = linha antiga/sem snapshot → segue).
  if (Array.isArray(row.items) && row.items.length === 0) {
    throw new CommerceCartError(
      "o carrinho está vazio — inclua ao menos um item antes de gerar o link de checkout",
      "carrinho_vazio",
    );
  }
  if (!moduleSecret) {
    throw new CommerceCartError(
      "o módulo de recuperação de carrinho não está configurado nesta loja — sem ele não é possível gerar link de checkout",
      "modulo_nao_configurado",
    );
  }

  // Passa pelo ledger como as demais mutações: era a única operação comercial sem rastro, e
  // justamente a que fecha a venda — se falhasse, não sobrava linha nenhuma para diagnosticar.
  return withLedger(
    admin,
    {
      organizationId: ctx.organizationId,
      integrationId: ctx.integrationId,
      operation: "cart.checkout_link",
      jobId: ctx.jobId,
      input: { cartId },
    },
    async () => {
      const origin = new URL(ctx.config.endpoint).origin;
      const res = await fetch(`${origin}/concierge/index/createLink`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Concierge-Secret": moduleSecret,
        },
        body: new URLSearchParams({ quote_id: row.external_quote_id }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new CommerceCartError(
          `não consegui gerar o link de recuperação (HTTP ${res.status}): ${text.slice(0, 200)}`,
          "link_de_recuperacao_falhou",
        );
      }
      const data = (await res.json()) as { url: string; expires_at: string };
      return { url: data.url, expiresAt: data.expires_at };
    },
  );
}
