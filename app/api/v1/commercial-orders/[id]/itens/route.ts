/**
 * PATCH /api/v1/commercial-orders/[id]/itens — edita os itens do RASCUNHO.
 *
 * Adicionar, remover e ajustar quantidade/preço/desconto — com as MESMAS
 * regras da criação (estoque, preço de tabela, totais server-side). Só em
 * rascunho/em_analise: pedido comprometido não se reescreve, se cancela e
 * refaz (o histórico fiscal agradece). Recalcula subtotal/total e as
 * parcelas; revalida crédito quando virar compromisso (o PATCH de status
 * faz, aqui só recalcula).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  calcularParcelas,
  COLUNAS_DO_ITEM,
  COLUNAS_DO_PEDIDO,
  itensPatchSchema,
  subtotalDoItem,
} from "@/lib/schemas/pedidos";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "commercial_orders" });
  if (!authz.ok) return authz.response;

  const parsed = itensPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  if (
    parsed.data.adicionar.length === 0 &&
    parsed.data.remover.length === 0 &&
    parsed.data.ajustar.length === 0
  ) {
    return fail("validation_failed", "Nada para alterar.", 422, { requestId });
  }

  const { id } = await params;
  const supabase = await createClient();

  const { data: pedido } = await supabase
    .from("commercial_orders")
    .select("id, status, desconto_cents, frete_cents, condicao_pagamento")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  const atual = pedido as unknown as {
    id: string;
    status: string;
    desconto_cents: number;
    frete_cents: number;
    condicao_pagamento: string | null;
  } | null;
  if (!atual) return fail("not_found", "Pedido não encontrado.", 404, { requestId });
  if (atual.status !== "rascunho" && atual.status !== "em_analise") {
    return fail(
      "validation_failed",
      `Pedido "${atual.status}" não aceita edição de itens. Cancele e refaça.`,
      422,
      { requestId },
    );
  }

  const { data: itensDb } = await supabase
    .from("commercial_order_items")
    .select(COLUNAS_DO_ITEM)
    .eq("order_id", id)
    .eq("organization_id", authz.org.orgId)
    .order("posicao");
  type Item = {
    id: string;
    product_id: string | null;
    produto_codigo: string;
    produto_nome: string;
    quantidade: number;
    preco_unit_cents: number;
    desconto_pct: number;
    subtotal_cents: number;
    posicao: number;
  };
  let itens = ((itensDb ?? []) as unknown as Item[]).map((i) => ({ ...i }));

  // Remover.
  const remover = new Set(parsed.data.remover);
  itens = itens.filter((i) => !remover.has(i.id));

  // Ajustar (quantidade/preço/desconto, com subtotal recalculado no servidor).
  for (const aj of parsed.data.ajustar) {
    const linha = itens.find((i) => i.id === aj.id);
    if (!linha) {
      return fail("validation_failed", "Um dos itens não é deste pedido.", 422, { requestId });
    }
    if (aj.quantidade !== undefined) linha.quantidade = aj.quantidade;
    if (aj.preco_unit_cents !== undefined) linha.preco_unit_cents = aj.preco_unit_cents;
    if (aj.desconto_pct !== undefined) linha.desconto_pct = aj.desconto_pct;
    linha.subtotal_cents = subtotalDoItem(linha.quantidade, linha.preco_unit_cents, linha.desconto_pct);
  }

  // Adicionar (snapshot mínimo: produto precisa existir para snapshot real —
  // sem product_id, entra como avulso com o preço informado).
  for (const novo of parsed.data.adicionar) {
    let codigo = "AVULSO";
    let nome = "Item avulso";
    if (novo.product_id) {
      const { data: prod } = await supabase
        .from("catalog_products")
        .select("codigo, nome")
        .eq("id", novo.product_id)
        .eq("organization_id", authz.org.orgId)
        .maybeSingle();
      const p = prod as unknown as { codigo: string; nome: string } | null;
      if (!p) {
        return fail("validation_failed", "Um dos produtos não existe.", 422, { requestId });
      }
      codigo = p.codigo;
      nome = p.nome;
    }
    itens.push({
      id: `novo-${itens.length}-${Date.now()}`,
      product_id: novo.product_id ?? null,
      produto_codigo: codigo,
      produto_nome: nome,
      quantidade: novo.quantidade,
      preco_unit_cents: novo.preco_unit_cents,
      desconto_pct: novo.desconto_pct,
      subtotal_cents: subtotalDoItem(novo.quantidade, novo.preco_unit_cents, novo.desconto_pct),
      posicao: itens.length,
    });
  }

  if (itens.length === 0) {
    return fail("validation_failed", "O pedido ficaria sem itens.", 422, { requestId });
  }

  const subtotal = itens.reduce((s, i) => s + i.subtotal_cents, 0);
  if (atual.desconto_cents > subtotal) {
    return fail("validation_failed", "Desconto maior que o subtotal.", 422, { requestId });
  }
  const total = subtotal - atual.desconto_cents + atual.frete_cents;

  // Troca total: apaga e reinsere (posições recalculadas). Rascunho sem
  // histórico de itens — o audit registra o gesto, não cada linha.
  const { error: erroApaga } = await supabase
    .from("commercial_order_items")
    .delete()
    .eq("order_id", id)
    .eq("organization_id", authz.org.orgId);
  if (erroApaga) return fail("internal_error", "Erro ao regravar os itens.", 500, { requestId });

  const { error: erroInsere } = await supabase.from("commercial_order_items").insert(
    itens.map((item, pos) => ({
      organization_id: authz.org.orgId,
      order_id: id,
      posicao: pos,
      product_id: item.product_id,
      produto_codigo: item.produto_codigo,
      produto_nome: item.produto_nome,
      quantidade: item.quantidade,
      preco_unit_cents: item.preco_unit_cents,
      desconto_pct: item.desconto_pct,
      subtotal_cents: item.subtotal_cents,
    })),
  );
  if (erroInsere) return fail("internal_error", "Erro ao regravar os itens.", 500, { requestId });

  const { data: atualizado, error } = await supabase
    .from("commercial_orders")
    .update({
      subtotal_cents: subtotal,
      total_cents: total,
      parcelas: calcularParcelas(total, atual.condicao_pagamento),
    })
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select(COLUNAS_DO_PEDIDO)
    .single();

  if (error || !atualizado) {
    return fail("internal_error", "Erro ao atualizar os totais.", 500, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "commercial_order.items_updated",
    resourceType: "commercial_orders",
    resourceId: id,
    requestId,
  });

  return ok(atualizado, { requestId });
}
