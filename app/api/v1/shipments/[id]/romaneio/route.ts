/**
 * GET /api/v1/shipments/[id]/romaneio — romaneio + fechamento em PDF único.
 *
 * O motorista leva um papel só: romaneio na frente (carrega e entrega),
 * fechamento atrás (presta contas). Mesmo molde do pedido em PDF.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { numeroDaCarga } from "@/lib/schemas/expedicao";
import { renderRomaneioEFechamentoPdf } from "@/lib/comercial/romaneio-pdf";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "shipments" });
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const supabase = await createClient();

  const [{ data: carga }, { data: org }] = await Promise.all([
    supabase
      .from("shipments")
      .select("numero, placa, veiculo_tipo, motorista_nome, created_at")
      .eq("id", id)
      .eq("organization_id", authz.org.orgId)
      .single(),
    supabase
      .from("organizations")
      .select("display_name, legal_name")
      .eq("id", authz.org.orgId)
      .single(),
  ]);

  if (!carga) return fail("not_found", "Carga não encontrada.", 404, { requestId });

  const { data: itens } = await supabase
    .from("shipment_orders")
    .select("sequencia, status, order_id, motivo, entregue_em")
    .eq("shipment_id", id)
    .eq("organization_id", authz.org.orgId)
    .order("sequencia");

  const ids = ((itens ?? []) as unknown as { order_id: string }[]).map((i) => i.order_id);
  interface LinhaPedido {
    id: string;
    numero: number;
    cliente_nome: string;
    endereco_entrega: string | null;
    total_cents: number;
    condicao_pagamento: string | null;
  }
  const pedidos: Record<string, LinhaPedido> = {};
  const itensPorPedido: Record<string, { codigo: string; nome: string; quantidade: number }[]> = {};
  const pagoPorPedido: Record<string, number> = {};
  if (ids.length > 0) {
    const [{ data }, { data: itensPedidos }, { data: recebiveis }] = await Promise.all([
      supabase
        .from("commercial_orders")
        .select("id, numero, cliente_nome, endereco_entrega, total_cents, condicao_pagamento")
        .eq("organization_id", authz.org.orgId)
        .in("id", ids),
      supabase
        .from("commercial_order_items")
        .select("order_id, produto_codigo, produto_nome, quantidade, posicao")
        .eq("organization_id", authz.org.orgId)
        .in("order_id", ids)
        .order("posicao"),
      supabase
        .from("financial_receivables")
        .select("order_id, valor_original_cents")
        .eq("organization_id", authz.org.orgId)
        .in("order_id", ids)
        .eq("status", "pago"),
    ]);
    for (const p of ((data ?? []) as unknown as LinhaPedido[])) {
      pedidos[p.id] = p;
    }
    for (const it of ((itensPedidos ?? []) as unknown as {
      order_id: string; produto_codigo: string; produto_nome: string; quantidade: number;
    }[])) {
      const lista = itensPorPedido[it.order_id] ?? [];
      lista.push({ codigo: it.produto_codigo, nome: it.produto_nome, quantidade: it.quantidade });
      itensPorPedido[it.order_id] = lista;
    }
    for (const r of ((recebiveis ?? []) as unknown as { order_id: string; valor_original_cents: number }[])) {
      pagoPorPedido[r.order_id] = (pagoPorPedido[r.order_id] ?? 0) + r.valor_original_cents;
    }
  }

  const c = carga as unknown as {
    numero: number;
    placa: string | null;
    veiculo_tipo: string | null;
    motorista_nome: string | null;
    created_at: string;
  };
  const o = (org ?? {}) as unknown as { display_name: string | null; legal_name: string | null };

  const buf = await renderRomaneioEFechamentoPdf(
    { nome: o.legal_name ?? o.display_name ?? "Empresa" },
    {
      numero: c.numero,
      placa: c.placa,
      veiculo_tipo: c.veiculo_tipo,
      motorista_nome: c.motorista_nome,
      montada_em: c.created_at,
      paradas: ((itens ?? []) as unknown as {
        sequencia: number; status: string; order_id: string; motivo: string | null; entregue_em: string | null;
      }[]).map((i) => {
        const ped = pedidos[i.order_id];
        return {
          sequencia: i.sequencia,
          numero: ped?.numero ?? 0,
          cliente_nome: ped?.cliente_nome ?? "—",
          endereco_entrega: ped?.endereco_entrega ?? null,
          total_cents: ped?.total_cents ?? 0,
          status: i.status,
          itens: itensPorPedido[i.order_id] ?? [],
          condicao: ped?.condicao_pagamento ?? null,
          motivo: i.motivo,
          entregue_em: i.entregue_em,
          pago_cents: pagoPorPedido[i.order_id] ?? 0,
        };
      }),
    },
    new Date().toISOString(),
  );

  const nome = `romaneio-${numeroDaCarga(c.numero).replace(/\s+/g, "-").toLowerCase()}.pdf`;
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${nome}"`,
      "X-Request-Id": requestId,
    },
  });
}
