import type { SupabaseClient } from "@supabase/supabase-js";

import { cabeNoCredito, situacaoDeCredito } from "@/lib/comercial/credito";
import {
  calcularParcelas,
  COLUNAS_DO_PEDIDO,
  subtotalDoItem,
  type PedidoCreate,
} from "@/lib/schemas/pedidos";
import { precoEfetivo } from "@/lib/schemas/precos";

/**
 * CRIAR PEDIDO — o serviço único, chamado pela rota REST e pela tool de IA.
 *
 * Extraído do POST /api/v1/commercial-orders sem mudar comportamento: a rota
 * continua dona de auth (requireRole), validação (Zod) e audit; o serviço é
 * dono das regras (políticas, tabelas, estoque, crédito, aprovação,
 * numeração, snapshot, compensação). Duas portas, uma regra — divergir as
 * duas seria vender diferente no WhatsApp e na tela.
 */

export interface ContextoDeCriacao {
  orgId: string;
  /** Quem cria (NULL quando é a IA — agente não é auth.users). */
  userId: string | null;
  /**
   * Override de estoque/crédito/preço liberado. A ROTA decide com o gate
   * manager; a TOOL passa sempre false (IA nunca ignora trava comercial).
   */
  podeIgnorar: boolean;
}

export type ResultadoDeCriacao =
  | { ok: true; pedido: Record<string, unknown>; itens: number; aprovacao_necessaria: boolean }
  | {
      ok: false;
      code: "validation_failed" | "internal_error" | "conflict";
      message: string;
      details?: Record<string, unknown>;
    };

interface PoliticaEfetiva {
  desconto_max_vendedor_pct: number;
  permite_estoque_negativo: boolean;
}

export async function criarPedidoComercial(
  supabase: SupabaseClient,
  admin: SupabaseClient,
  ctx: ContextoDeCriacao,
  entrada: PedidoCreate,
): Promise<ResultadoDeCriacao> {
  // Políticas da org (defaults seguros quando sem linha).
  const { data: polDb } = await supabase
    .from("commercial_policies")
    .select("desconto_max_vendedor_pct, permite_estoque_negativo")
    .eq("organization_id", ctx.orgId)
    .maybeSingle();
  const politica: PoliticaEfetiva = {
    desconto_max_vendedor_pct: Number(
      (polDb as unknown as { desconto_max_vendedor_pct: number } | null)?.desconto_max_vendedor_pct ?? 5,
    ),
    permite_estoque_negativo:
      (polDb as unknown as { permite_estoque_negativo: boolean } | null)?.permite_estoque_negativo ?? false,
  };

  // Tabela de preço (se pedida): desconto + overrides por produto.
  let descontoTabelaPct = 0;
  const precoNaTabela = new Map<string, number | null>();
  if (entrada.price_table_id) {
    const [{ data: tab }, { data: itensTab }] = await Promise.all([
      supabase
        .from("price_tables")
        .select("desconto_pct, ativo")
        .eq("id", entrada.price_table_id)
        .eq("organization_id", ctx.orgId)
        .maybeSingle(),
      supabase
        .from("price_table_items")
        .select("product_id, preco_cents")
        .eq("price_table_id", entrada.price_table_id)
        .eq("organization_id", ctx.orgId),
    ]);
    const t = tab as unknown as { desconto_pct: number; ativo: boolean } | null;
    if (!t || !t.ativo) {
      return { ok: false, code: "validation_failed", message: "Tabela de preço inválida ou inativa." };
    }
    descontoTabelaPct = Number(t.desconto_pct);
    for (const i of ((itensTab ?? []) as unknown as { product_id: string; preco_cents: number | null }[])) {
      precoNaTabela.set(i.product_id, i.preco_cents);
    }
  }

  // Produtos dos itens, numa query só — snapshot, estoque e base de preço.
  const idsProdutos = [...new Set(entrada.itens.map((i) => i.product_id).filter(Boolean))] as string[];
  const produtos = new Map<
    string,
    { codigo: string; nome: string; controla_estoque: boolean; quantidade: number; preco_cents: number }
  >();
  if (idsProdutos.length > 0) {
    const { data, error } = await supabase
      .from("catalog_products")
      .select("id, codigo, nome, controla_estoque, quantidade, preco_cents")
      .eq("organization_id", ctx.orgId)
      .in("id", idsProdutos);
    if (error) return { ok: false, code: "internal_error", message: "Erro ao ler os produtos." };
    for (const p of data ?? []) {
      produtos.set(
        p.id,
        p as { codigo: string; nome: string; controla_estoque: boolean; quantidade: number; preco_cents: number },
      );
    }
  }

  // Monta os itens com snapshot + subtotal calculado no SERVIDOR.
  const itensMontados: {
    product_id: string | null;
    produto_codigo: string;
    produto_nome: string;
    quantidade: number;
    preco_unit_cents: number;
    desconto_pct: number;
    subtotal_cents: number;
  }[] = [];
  let descontoMaxItem = 0;
  for (const [pos, item] of entrada.itens.entries()) {
    const prod = item.product_id ? produtos.get(item.product_id) : undefined;
    if (item.product_id && !prod) {
      return {
        ok: false,
        code: "validation_failed",
        message: "Um dos produtos não existe.",
        details: { itens: [`item ${pos + 1}: produto não encontrado`] },
      };
    }
    // Preço efetivo (§12): com tabela, o SERVIDOR decide. Preço diferente do
    // efetivo = negociado: só com poder de gerente.
    let precoUnit = item.preco_unit_cents;
    if (prod && entrada.price_table_id) {
      const efetivo = precoEfetivo(
        prod.preco_cents,
        descontoTabelaPct,
        item.product_id ? (precoNaTabela.get(item.product_id) ?? null) : null,
      );
      if (efetivo !== item.preco_unit_cents && !ctx.podeIgnorar) {
        return {
          ok: false,
          code: "validation_failed",
          message: `Preço fora da tabela em "${prod.nome}" (tabela: ${efetivo}).`,
          details: { itens: [`item ${pos + 1}: preço de tabela ${efetivo}`] },
        };
      }
      if (efetivo === item.preco_unit_cents) precoUnit = efetivo;
    }
    const semEstoque =
      prod &&
      prod.controla_estoque &&
      prod.quantidade < item.quantidade &&
      !politica.permite_estoque_negativo &&
      !(entrada.ignorar_estoque && ctx.podeIgnorar);
    if (semEstoque && prod) {
      return {
        ok: false,
        code: "validation_failed",
        message: `Estoque insuficiente para "${prod.nome}".`,
        details: { itens: [`item ${pos + 1}: disponível ${prod.quantidade}, pedido ${item.quantidade}`] },
      };
    }
    descontoMaxItem = Math.max(descontoMaxItem, item.desconto_pct);
    itensMontados.push({
      product_id: item.product_id ?? null,
      produto_codigo: prod?.codigo ?? "AVULSO",
      produto_nome: prod?.nome ?? "Item avulso",
      quantidade: item.quantidade,
      preco_unit_cents: precoUnit,
      desconto_pct: item.desconto_pct,
      subtotal_cents: subtotalDoItem(item.quantidade, precoUnit, item.desconto_pct),
    });
  }

  const subtotal = itensMontados.reduce((s, i) => s + i.subtotal_cents, 0);
  // Desconto geral: R$ + % (somam). % vira cents aqui, no servidor.
  const descontoPctGeral = entrada.desconto_pct ?? 0;
  const descontoGeralCents = entrada.desconto_cents + Math.round((subtotal * descontoPctGeral) / 100);
  if (descontoGeralCents > subtotal) {
    return { ok: false, code: "validation_failed", message: "Desconto maior que o subtotal." };
  }
  const total = subtotal - descontoGeralCents + entrada.frete_cents;

  // Aprovação (§14–15): maior desconto (item ou geral) acima do teto escala
  // para `em_analise` sozinho — salvo rascunho (intenção) ou gerente.
  const maiorDesconto = Math.max(descontoMaxItem, descontoPctGeral);
  let statusFinal = entrada.status;
  let aprovacaoNecessaria = false;
  if (
    entrada.status !== "rascunho" &&
    maiorDesconto > politica.desconto_max_vendedor_pct &&
    !ctx.podeIgnorar
  ) {
    statusFinal = "em_analise";
    aprovacaoNecessaria = true;
  }

  // Crédito: rascunho nunca barra; compromisso acima do limite sim.
  if (statusFinal !== "rascunho" && entrada.contact_id && !(entrada.ignorar_credito && ctx.podeIgnorar)) {
    const situacao = await situacaoDeCredito(supabase, ctx.orgId, entrada.contact_id);
    if (!cabeNoCredito(situacao, total)) {
      return {
        ok: false,
        code: "validation_failed",
        message: "Cliente acima do limite de crédito.",
        details: {
          limite_cents: situacao.limite_cents,
          em_aberto_cents: situacao.em_aberto_cents,
          novo_total_cents: total,
        },
      };
    }
  }

  // Número atômico via 0209 (definer valida membership internamente; com
  // service role, o firewall é a org do contexto — fonte do JWT/token).
  const { data: numero, error: erroNumero } = await supabase.rpc("fn_proximo_numero_pedido", {
    p_org: ctx.orgId,
  });
  if (erroNumero || typeof numero !== "number") {
    return { ok: false, code: "internal_error", message: "Erro ao numerar o pedido." };
  }

  const { data: pedido, error: erroPedido } = await supabase
    .from("commercial_orders")
    .insert({
      organization_id: ctx.orgId,
      numero,
      contact_id: entrada.contact_id ?? null,
      cliente_nome: entrada.cliente_nome,
      cliente_documento: entrada.cliente_documento ?? null,
      vendedor_user_id: entrada.vendedor_user_id ?? null,
      status: statusFinal,
      origem: entrada.origem,
      moeda: entrada.moeda,
      subtotal_cents: subtotal,
      desconto_cents: descontoGeralCents,
      desconto_pct: descontoPctGeral > 0 ? descontoPctGeral : null,
      frete_cents: entrada.frete_cents,
      total_cents: total,
      condicao_pagamento: entrada.condicao_pagamento ?? null,
      price_table_id: entrada.price_table_id ?? null,
      observacoes: entrada.observacoes ?? null,
      obs_interna: entrada.obs_interna ?? null,
      endereco_entrega: entrada.endereco_entrega ?? null,
      transportadora_nome: entrada.transportadora_nome ?? null,
      modalidade_frete: entrada.modalidade_frete,
      previsao_entrega: entrada.previsao_entrega ?? null,
      parcelas: calcularParcelas(total, entrada.condicao_pagamento),
      created_by: ctx.userId,
    })
    .select(COLUNAS_DO_PEDIDO)
    .single();

  if (erroPedido || !pedido) {
    return { ok: false, code: "internal_error", message: "Erro ao salvar o pedido." };
  }
  const pedidoId = (pedido as unknown as { id: string }).id;

  const { error: erroItens } = await supabase.from("commercial_order_items").insert(
    itensMontados.map((item, pos) => ({
      organization_id: ctx.orgId,
      order_id: pedidoId,
      posicao: pos,
      ...item,
    })),
  );
  if (erroItens) {
    // Compensação: sem itens o pedido é casca. Apaga para não deixar órfão.
    await supabase.from("commercial_orders").delete().eq("id", pedidoId);
    return { ok: false, code: "internal_error", message: "Erro ao salvar os itens do pedido." };
  }

  // Baixa de estoque só fora do rascunho: rascunho é intenção, não venda.
  if (statusFinal !== "rascunho") {
    for (const item of itensMontados) {
      if (!item.product_id) continue;
      const prod = produtos.get(item.product_id);
      if (!prod?.controla_estoque) continue;
      await admin
        .from("catalog_products")
        .update({ quantidade: prod.quantidade - item.quantidade })
        .eq("id", item.product_id)
        .eq("organization_id", ctx.orgId);
    }
  }

  return {
    ok: true,
    pedido: { ...(pedido as unknown as Record<string, unknown>), numero },
    itens: itensMontados.length,
    aprovacao_necessaria: aprovacaoNecessaria,
  };
}
