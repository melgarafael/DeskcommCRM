/**
 * GET /api/v1/financeiro/conciliacao — divergências pedido × NF × financeiro.
 *
 * Detecta (tudo do banco, sem mock):
 * - pedido_sem_financeiro (faturado/expedido/entregue sem recebível)
 * - financeiro_sem_pedido (recebível avulso)
 * - nf_sem_financeiro (invoice autorizada sem recebível)
 * - financeiro_sem_nf (recebível de pedido faturado sem invoice)
 * - valor_divergente (soma dos recebíveis ≠ total do pedido)
 * Cap de 200 linhas por tipo — é painel de exceção, não relatório contábil.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export type Divergencia =
  | { tipo: "pedido_sem_financeiro"; order_id: string; numero: number | null; cliente: string; total_cents: number }
  | { tipo: "financeiro_sem_pedido"; receivable_id: string; contato: string | null; valor_cents: number }
  | { tipo: "nf_sem_financeiro"; invoice_id: string; numero: number | null; total_cents: number }
  | { tipo: "financeiro_sem_nf"; receivable_id: string; order_id: string; total_cents: number }
  | { tipo: "valor_divergente"; order_id: string; numero: number | null; pedido_cents: number; recebiveis_cents: number };

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "financial_receivables" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const orgId = authz.org.orgId;

  const [pedidosRes, recRes, notasRes] = await Promise.all([
    supabase
      .from("commercial_orders")
      .select("id, numero, cliente_nome, total_cents, status")
      .eq("organization_id", orgId)
      .in("status", ["faturado", "expedido", "entregue"])
      .order("created_at", { ascending: false })
      .limit(2000),
    supabase
      .from("financial_receivables")
      .select("id, order_id, invoice_id, contact_id, valor_original_cents, status")
      .eq("organization_id", orgId)
      .neq("status", "cancelado")
      .limit(5000),
    supabase
      .from("invoices")
      .select("id, order_id, numero, total_cents, status")
      .eq("organization_id", orgId)
      .eq("status", "autorizada")
      .limit(2000),
  ]);
  if (pedidosRes.error || recRes.error || notasRes.error) {
    return fail("internal_error", "Erro ao ler base da conciliação.", 500, { requestId });
  }
  const pedidos = pedidosRes.data;
  const recs = recRes.data;
  const notas = notasRes.data;

  const listaPedidos = (pedidos ?? []) as unknown as {
    id: string; numero: number; cliente_nome: string; total_cents: number; status: string;
  }[];
  const listaRec = (recs ?? []) as unknown as {
    id: string; order_id: string | null; invoice_id: string | null; contact_id: string | null; valor_original_cents: number;
  }[];
  const listaNotas = (notas ?? []) as unknown as {
    id: string; order_id: string | null; numero: number | null; total_cents: number;
  }[];

  const recPorPedido = new Map<string, typeof listaRec>();
  const semPedido: typeof listaRec = [];
  for (const r of listaRec) {
    if (!r.order_id) {
      semPedido.push(r);
      continue;
    }
    const lista = recPorPedido.get(r.order_id) ?? [];
    lista.push(r);
    recPorPedido.set(r.order_id, lista);
  }
  const nfsComRec = new Set(listaRec.map((r) => r.invoice_id).filter((v): v is string => !!v));

  const out: Divergencia[] = [];
  for (const p of listaPedidos) {
    const rs = recPorPedido.get(p.id) ?? [];
    if (rs.length === 0) {
      if (out.length < 200) {
        out.push({ tipo: "pedido_sem_financeiro", order_id: p.id, numero: p.numero, cliente: p.cliente_nome, total_cents: p.total_cents });
      }
      continue;
    }
    const soma = rs.reduce((s, r) => s + r.valor_original_cents, 0);
    if (soma !== p.total_cents && out.length < 200) {
      out.push({ tipo: "valor_divergente", order_id: p.id, numero: p.numero, pedido_cents: p.total_cents, recebiveis_cents: soma });
    }
  }
  for (const r of semPedido.slice(0, 200)) {
    out.push({ tipo: "financeiro_sem_pedido", receivable_id: r.id, contato: r.contact_id, valor_cents: r.valor_original_cents });
  }
  for (const n of listaNotas) {
    if (!nfsComRec.has(n.id) && out.length < 200) {
      out.push({ tipo: "nf_sem_financeiro", invoice_id: n.id, numero: n.numero, total_cents: n.total_cents });
    }
  }
  // financeiro de pedido faturado sem NF vinculada.
  const nfsPorPedido = new Set(listaNotas.map((n) => n.order_id).filter((v): v is string => !!v));
  for (const [orderId, rs] of recPorPedido) {
    if (!nfsPorPedido.has(orderId) && out.length < 200) {
      const soma = rs.reduce((s, r) => s + r.valor_original_cents, 0);
      out.push({ tipo: "financeiro_sem_nf", receivable_id: rs[0]?.id ?? "", order_id: orderId, total_cents: soma });
    }
  }

  return ok({ data: out.slice(0, 200), total: out.length }, { requestId });
}
