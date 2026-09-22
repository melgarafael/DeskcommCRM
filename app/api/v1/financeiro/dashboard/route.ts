/**
 * GET /api/v1/financeiro/dashboard — KPIs do financeiro, tudo do banco.
 *
 * `?de=YYYY-MM-DD&ate=YYYY-MM-DD` recorta vendas e recebimentos; o estoque
 * (a receber/vencido/hoje/7d) é sempre posição atual. Uma chamada, sem N+1.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { situacaoDe } from "@/lib/comercial/financeiro";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const DIA = 86400000;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "financial_receivables" });
  if (!authz.ok) return authz.response;

  const de = req.nextUrl.searchParams.get("de")?.trim() || null;
  const ate = req.nextUrl.searchParams.get("ate")?.trim() || null;
  const supabase = await createClient();
  const orgId = authz.org.orgId;
  const hoje = new Date().toISOString().slice(0, 10);
  const hojeMs = new Date(`${hoje}T12:00:00Z`).getTime();

  const { data: recs, error: erroRec } = await supabase
    .from("financial_receivables")
    .select("id, valor_original_cents, vencimento, status")
    .eq("organization_id", orgId)
    .neq("status", "cancelado")
    .limit(5000);
  if (erroRec) return fail("internal_error", "Erro ao agregar recebíveis.", 500, { requestId });
  const linhas = (recs ?? []) as unknown as {
    id: string;
    valor_original_cents: number;
    vencimento: string;
    status: "aberto" | "parcial" | "pago" | "cancelado";
  }[];
  const ids = linhas.map((l) => l.id);
  const { data: pags } = ids.length > 0
    ? await supabase
        .from("financial_payments")
        .select("receivable_id, valor_cents, pago_em")
        .eq("organization_id", orgId)
        .in("receivable_id", ids)
        .limit(10000)
    : { data: [] as unknown[] };
  const porRec = new Map<string, { valor_cents: number; pago_em: string }[]>();
  for (const p of (pags ?? []) as unknown as { receivable_id: string; valor_cents: number; pago_em: string }[]) {
    const lista = porRec.get(p.receivable_id) ?? [];
    lista.push({ valor_cents: p.valor_cents, pago_em: p.pago_em });
    porRec.set(p.receivable_id, lista);
  }

  let aReceber = 0;
  let vencido = 0;
  let venceHoje = 0;
  let vence7d = 0;
  let recebidoPeriodo = 0;
  for (const l of linhas) {
    const sit = situacaoDe(
      { status: l.status, valor_original_cents: l.valor_original_cents, vencimento: l.vencimento },
      porRec.get(l.id) ?? [],
      hoje,
    );
    aReceber += sit.saldo_cents;
    if (sit.situacao === "vencido") vencido += sit.saldo_cents;
    if (l.vencimento === hoje && sit.saldo_cents > 0) venceHoje += sit.saldo_cents;
    const dv = new Date(`${l.vencimento}T12:00:00Z`).getTime();
    if (dv > hojeMs && dv <= hojeMs + 7 * DIA && sit.saldo_cents > 0) vence7d += sit.saldo_cents;
    for (const pg of porRec.get(l.id) ?? []) {
      const dia = pg.pago_em.slice(0, 10);
      if ((!de || dia >= de) && (!ate || dia <= ate)) recebidoPeriodo += pg.valor_cents;
    }
  }

  let vendasQ = supabase
    .from("commercial_orders")
    .select("total_cents, contact_id")
    .eq("organization_id", orgId)
    .not("status", "in", "(rascunho,cancelado)")
    .limit(10000);
  if (de) vendasQ = vendasQ.gte("created_at", `${de}T00:00:00Z`);
  if (ate) vendasQ = vendasQ.lt("created_at", `${ate}T00:00:00Z`);
  const { data: vendas } = await vendasQ;
  const listaVendas = (vendas ?? []) as unknown as { total_cents: number; contact_id: string | null }[];
  const vendasPeriodo = listaVendas.reduce((s, v) => s + v.total_cents, 0);
  const compradores = new Set(listaVendas.map((v) => v.contact_id).filter(Boolean)).size;

  return ok(
    {
      a_receber_cents: aReceber,
      vencido_cents: vencido,
      vence_hoje_cents: venceHoje,
      vence_7d_cents: vence7d,
      recebido_periodo_cents: recebidoPeriodo,
      vendas_periodo_cents: vendasPeriodo,
      ticket_medio_cents: listaVendas.length === 0 ? 0 : Math.round(vendasPeriodo / listaVendas.length),
      compradores,
      qtd_recebiveis: linhas.length,
    },
    { requestId },
  );
}
