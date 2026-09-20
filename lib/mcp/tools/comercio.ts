/**
 * Capacidades de COMÉRCIO — o que o cliente já comprou e o que existe à venda.
 *
 * Ficou de fora do épico até ser cobrado, e era a lacuna mais direta do pilar 1:
 * um agente de vendas que não enxerga o catálogo nem o histórico de pedidos
 * negocia no escuro — promete o que não existe, ou repete uma oferta que o
 * cliente já comprou.
 *
 * Service role bypassa RLS: TODA query filtra `organization_id` manualmente, e a
 * fonte é sempre `ctx.organizationId` (token/cookie), NUNCA o input.
 */
import { z } from "zod";

import type { McpToolDefinition } from "../types";

// ---------------------------------------------------------------------------
// pedidos de um cliente
// ---------------------------------------------------------------------------

const pedidosInputShape = {
  contact_id: z.string().uuid().describe("O cliente cujos pedidos se quer ver."),
  limite: z.number().int().min(1).max(20).optional().default(10),
};

export const crmListContactOrders: McpToolDefinition<typeof pedidosInputShape> = {
  name: "crm_list_contact_orders",
  description:
    "Lista os pedidos de um contato, do mais recente para o mais antigo, com status, valor, " +
    "forma de pagamento, situação de entrega e código de rastreio. Use antes de prometer prazo " +
    "ou repetir oferta: o cliente pode já ter comprado.",
  inputSchema: pedidosInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const { data, error } = await ctx.supabase
      .from("orders")
      .select(
        "id, external_id, external_provider, status, total_cents, currency, payment_method, fulfillment_status, tracking_code, ordered_at, is_anonymized",
      )
      .eq("organization_id", ctx.organizationId)
      .eq("contact_id", input.contact_id)
      .order("ordered_at", { ascending: false, nullsFirst: false })
      .limit(input.limite);

    if (error) throw new Error(`listar_pedidos_falhou: ${error.message}`);

    return {
      pedidos: (data ?? []).map((p) => ({
        ...p,
        // Pedido anonimizado por LGPD continua contando para histórico, mas o
        // conteúdo não volta: dizer isso é melhor que devolver campos vazios e
        // deixar o modelo concluir que o cliente nunca comprou.
        ...(p.is_anonymized ? { aviso: "pedido anonimizado a pedido do titular" } : {}),
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// buscar no catálogo
// ---------------------------------------------------------------------------

const produtosInputShape = {
  termo: z.string().trim().min(2).describe("Parte do nome do produto."),
  limite: z.number().int().min(1).max(20).optional().default(10),
  somente_disponiveis: z.boolean().optional().default(true),
};

export const crmSearchProducts: McpToolDefinition<typeof produtosInputShape> = {
  name: "crm_search_products",
  description:
    "Busca produtos do catálogo da loja por parte do nome. Devolve preço, quantidade disponível " +
    "e link. Use para responder preço e disponibilidade com o dado da loja em vez de estimar.",
  inputSchema: produtosInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    let q = ctx.supabase
      .from("nuvemshop_products")
      .select("id, external_id, title, description, price_cents, available_qty, url, image_url")
      .eq("organization_id", ctx.organizationId)
      .ilike("title", `%${input.termo}%`)
      .limit(input.limite);

    // Oferecer o que está sem estoque é pior que não achar: o cliente ouve um
    // sim e recebe um não depois.
    if (input.somente_disponiveis) q = q.gt("available_qty", 0);

    const { data, error } = await q;
    if (error) throw new Error(`buscar_produtos_falhou: ${error.message}`);

    return {
      produtos: data ?? [],
      ...(data && data.length === 0
        ? { aviso: input.somente_disponiveis ? "nada com esse nome em estoque" : "nada com esse nome no catálogo" }
        : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// buscar no catálogo Magento (cache — plano de concierge de compras §6.2)
// ---------------------------------------------------------------------------

const catalogoInputShape = {
  termo: z.string().trim().min(2).describe("Parte do nome ou do SKU do produto."),
  limite: z.number().int().min(1).max(20).optional().default(10),
};

export const commerceSearchProducts: McpToolDefinition<typeof catalogoInputShape> = {
  name: "commerce_search_products",
  description:
    "Busca no catálogo Magento por nome ou SKU. Devolve identidade, tipo e link do produto — " +
    "NÃO devolve preço confirmado: este é um cache de busca, e o Magento continua sendo a fonte " +
    "de preço/estoque efetivos. Produtos que a loja marcou SEM ESTOQUE não aparecem aqui (o cache " +
    "de estoque atualiza algumas vezes ao dia), mas o estoque só é garantido ao apresentar o " +
    "produto (present_product) e ao incluir no carrinho — não prometa ao cliente antes disso.",
  inputSchema: catalogoInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const termo = input.termo.replace(/[%_]/g, (c) => `\\${c}`);
    const { data, error } = await ctx.supabase
      .from("commerce_products")
      .select("external_id, sku, type, name, url_path, category_ids, store_view")
      .eq("organization_id", ctx.organizationId)
      .or(`name.ilike.%${termo}%,sku.ilike.%${termo}%`)
      // NULL = estoque ainda desconhecido → segue ofertável (fail-open); só some quem a loja
      // marcou is_in_stock=false. NÃO filtrar por stock_qty: existe qty>0 com is_in_stock=false.
      .not("is_in_stock", "is", false)
      .limit(input.limite);

    if (error) throw new Error(`buscar_catalogo_magento_falhou: ${error.message}`);

    return {
      produtos: data ?? [],
      ...(data && data.length === 0 ? { aviso: "nada com esse nome/SKU no catálogo importado" } : {}),
    };
  },
};
