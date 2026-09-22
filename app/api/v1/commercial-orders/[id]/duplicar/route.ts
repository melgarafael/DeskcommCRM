/**
 * POST /api/v1/commercial-orders/[id]/duplicar — repete o pedido (§33–34).
 *
 * Novo rascunho com cliente, itens, quantidades e condições; NUNCA copia
 * status, número, timestamps nem vínculo fiscal. Preços e estoque REVALIDADOS
 * contra o catálogo de hoje (não copia valor velho): item sem produto ou sem
 * estoque entra na resposta como `avisos`, e o rascunho nasce com o que vale.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { criarPedidoComercial } from "@/lib/comercial/criar-pedido";
import { numeroDoPedido } from "@/lib/format/moeda";
import { COLUNAS_DO_ITEM } from "@/lib/schemas/pedidos";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "commercial_orders" });
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const supabase = await createClient();

  const { data: origem } = await supabase
    .from("commercial_orders")
    .select(
      "contact_id, cliente_nome, cliente_documento, vendedor_user_id, origem, moeda, numero, " +
        "condicao_pagamento, observacoes, obs_interna, endereco_entrega, transportadora_nome, " +
        "modalidade_frete, desconto_cents, frete_cents",
    )
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  const base = origem as unknown as {
    contact_id: string | null;
    cliente_nome: string;
    cliente_documento: string | null;
    vendedor_user_id: string | null;
    origem: string;
    moeda: string;
    numero: number;
    condicao_pagamento: string | null;
    observacoes: string | null;
    obs_interna: string | null;
    endereco_entrega: string | null;
    transportadora_nome: string | null;
    modalidade_frete: "retirada" | "propria" | "terceirizada";
    desconto_cents: number;
    frete_cents: number;
  } | null;
  if (!base) return fail("not_found", "Pedido não encontrado.", 404, { requestId });

  const { data: itensDb } = await supabase
    .from("commercial_order_items")
    .select(COLUNAS_DO_ITEM)
    .eq("order_id", id)
    .eq("organization_id", authz.org.orgId)
    .order("posicao");
  const itensOrigem = ((itensDb ?? []) as unknown as {
    product_id: string | null;
    quantidade: number;
    preco_unit_cents: number;
    desconto_pct: number;
  }[]);
  if (itensOrigem.length === 0) {
    return fail("validation_failed", "Pedido sem itens para duplicar.", 422, { requestId });
  }

  // Revalida preços contra o catálogo de HOJE (não copia valor velho).
  const ids = [...new Set(itensOrigem.map((i) => i.product_id).filter(Boolean))] as string[];
  const precos = new Map<string, { preco_cents: number; quantidade: number; controla_estoque: boolean; codigo: string }>();
  if (ids.length > 0) {
    const { data: prods } = await supabase
      .from("catalog_products")
      .select("id, preco_cents, quantidade, controla_estoque, codigo")
      .eq("organization_id", authz.org.orgId)
      .in("id", ids);
    for (const p of (prods ?? []) as unknown as {
      id: string;
      preco_cents: number;
      quantidade: number;
      controla_estoque: boolean;
      codigo: string;
    }[]) {
      precos.set(p.id, p);
    }
  }

  const avisos: string[] = [];
  const itens = [];
  for (const item of itensOrigem) {
    if (!item.product_id) {
      itens.push({
        product_id: null,
        quantidade: item.quantidade,
        preco_unit_cents: item.preco_unit_cents,
        desconto_pct: item.desconto_pct,
      });
      continue;
    }
    const atual = precos.get(item.product_id);
    if (!atual) {
      avisos.push(`"${item.product_id}" saiu do catálogo — item fora do rascunho.`);
      continue;
    }
    if (atual.controla_estoque && atual.quantidade < item.quantidade) {
      avisos.push(
        `"${atual.codigo}" sem estoque suficiente (tem ${atual.quantidade}) — confere antes de enviar.`,
      );
    }
    if (atual.preco_cents !== item.preco_unit_cents) {
      avisos.push(`"${atual.codigo}" mudou de preço — vale o atual.`);
    }
    itens.push({
      product_id: item.product_id,
      quantidade: item.quantidade,
      preco_unit_cents: atual.preco_cents,
      desconto_pct: item.desconto_pct,
    });
  }
  if (itens.length === 0) {
    return fail("validation_failed", "Nenhum item válido para duplicar.", 422, {
      requestId,
      details: { avisos },
    });
  }

  const resultado = await criarPedidoComercial(supabase, createAdminClient(), {
    orgId: authz.org.orgId,
    userId: authz.user.id,
    podeIgnorar: false,
  }, {
    contact_id: base.contact_id,
    cliente_nome: base.cliente_nome,
    cliente_documento: base.cliente_documento ?? undefined,
    vendedor_user_id: base.vendedor_user_id,
    status: "rascunho",
    // Nasce AQUI, não no sistema de origem: duplicar um pedido "mercos" não
    // faz o novo ter vindo do Mercos — o badge diria uma origem falsa e
    // poluía os relatórios por canal. A procedência vai nas observações.
    origem: "vendedor",
    moeda: base.moeda,
    desconto_cents: base.desconto_cents,
    frete_cents: base.frete_cents,
    condicao_pagamento: base.condicao_pagamento ?? undefined,
    observacoes: [`Duplicado de ${numeroDoPedido(base.numero)} (origem ${base.origem})`,
      base.observacoes ?? ""].filter(Boolean).join(" | "),
    obs_interna: base.obs_interna ?? undefined,
    endereco_entrega: base.endereco_entrega ?? undefined,
    transportadora_nome: base.transportadora_nome ?? undefined,
    modalidade_frete: base.modalidade_frete,
    ignorar_estoque: false,
    ignorar_credito: false,
    itens,
  });

  if (!resultado.ok) {
    return fail(
      resultado.code === "validation_failed" ? "validation_failed" : "internal_error",
      resultado.message,
      resultado.code === "validation_failed" ? 422 : 500,
      { requestId, ...(resultado.details ? { details: resultado.details } : {}) },
    );
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "commercial_order.duplicated",
    resourceType: "commercial_orders",
    resourceId: (resultado.pedido as { id: string }).id,
    requestId,
  });

  return ok({ ...resultado.pedido, avisos }, { requestId, status: 201 });
}
