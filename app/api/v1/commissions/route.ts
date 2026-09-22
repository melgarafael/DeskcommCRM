/**
 * GET /api/v1/commissions — comissão por pedido no mês (leitura: viewer+).
 *
 * A regra mora no produto (`catalog_products.comissao_pct`); aqui cruza
 * itens × regra e marca o que já teve baixa (`commercial_commission_baixas`).
 * Query params: ?ano_mes=YYYY-MM (obrigatório), ?vendedor=<uuid> (opcional).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { comissaoDoPedido } from "@/lib/comercial/comissao";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const ANO_MES = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

export interface LinhaComissao {
  order_id: string;
  numero: number;
  cliente_nome: string;
  vendedor_user_id: string | null;
  data_emissao: string;
  total_cents: number;
  comissao_cents: number;
  base_cents: number;
  baixado_em: string | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "commercial_commission_baixas" });
  if (!authz.ok) return authz.response;

  const anoMes = req.nextUrl.searchParams.get("ano_mes")?.trim() ?? "";
  if (!ANO_MES.test(anoMes)) {
    return fail("validation_failed", "Passe ?ano_mes=YYYY-MM.", 422, { requestId });
  }
  const vendedor = req.nextUrl.searchParams.get("vendedor")?.trim() || null;

  const supabase = await createClient();
  const [ano = 0, mes = 1] = anoMes.split("-").map(Number);
  const inicio = `${anoMes}-01T00:00:00Z`;
  const fim = new Date(Date.UTC(ano, mes, 1)).toISOString();

  let q = supabase
    .from("commercial_orders")
    .select("id, numero, cliente_nome, vendedor_user_id, total_cents, created_at")
    .eq("organization_id", authz.org.orgId)
    .not("status", "in", "(rascunho,cancelado)")
    .gte("created_at", inicio)
    .lt("created_at", fim)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (vendedor) q = q.eq("vendedor_user_id", vendedor);
  const { data: pedidos, error: erroPedidos } = await q;
  if (erroPedidos) return fail("internal_error", "Erro ao ler os pedidos.", 500, { requestId });

  const ids = ((pedidos ?? []) as { id: string }[]).map((p) => p.id);
  let itens: { order_id: string; subtotal_cents: number; product_id: string | null }[] = [];
  let regras = new Map<string, number | null>();
  let baixas = new Map<string, string>();
  if (ids.length > 0) {
    const [{ data: itensDb, error: erroItens }, { data: baixasDb }] = await Promise.all([
      supabase
        .from("commercial_order_items")
        .select("order_id, subtotal_cents, product_id")
        .eq("organization_id", authz.org.orgId)
        .in("order_id", ids),
      supabase
        .from("commercial_commission_baixas")
        .select("order_id, baixado_em")
        .eq("organization_id", authz.org.orgId)
        .in("order_id", ids),
    ]);
    if (erroItens) return fail("internal_error", "Erro ao ler os itens.", 500, { requestId });
    itens = (itensDb ?? []) as typeof itens;
    baixas = new Map(((baixasDb ?? []) as { order_id: string; baixado_em: string }[]).map((b) => [b.order_id, b.baixado_em]));
    const prodIds = [...new Set(itens.map((i) => i.product_id).filter(Boolean))] as string[];
    if (prodIds.length > 0) {
      const { data: prods } = await supabase
        .from("catalog_products")
        .select("id, comissao_pct")
        .eq("organization_id", authz.org.orgId)
        .in("id", prodIds);
      regras = new Map(((prods ?? []) as { id: string; comissao_pct: number | null }[]).map((p) => [p.id, p.comissao_pct]));
    }
  }

  const porPedido = new Map<string, { subtotal_cents: number; product_id: string | null }[]>();
  for (const it of itens) {
    const lista = porPedido.get(it.order_id) ?? [];
    lista.push(it);
    porPedido.set(it.order_id, lista);
  }

  const linhas: LinhaComissao[] = ((pedidos ?? []) as {
    id: string; numero: number; cliente_nome: string; vendedor_user_id: string | null;
    total_cents: number; created_at: string;
  }[]).map((p) => {
    const calc = comissaoDoPedido(
      (porPedido.get(p.id) ?? []).map((it) => ({
        subtotal_cents: it.subtotal_cents,
        comissao_pct: it.product_id ? (regras.get(it.product_id) ?? null) : null,
      })),
    );
    return {
      order_id: p.id,
      numero: p.numero,
      cliente_nome: p.cliente_nome,
      vendedor_user_id: p.vendedor_user_id,
      data_emissao: p.created_at,
      total_cents: p.total_cents,
      comissao_cents: calc.cents,
      base_cents: calc.base_cents,
      baixado_em: baixas.get(p.id) ?? null,
    };
  });

  return ok(linhas, { requestId });
}
