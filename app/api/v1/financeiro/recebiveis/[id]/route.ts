/**
 * GET /api/v1/financeiro/recebiveis/[id] — detalhe com pagamentos e vínculos.
 *
 * Traz o recebível + soma paga/saldo/situação + pagamentos + pedido/NF
 * vinculados. É o que a tela de detalhe e o Cliente 360 leem.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { situacaoDe } from "@/lib/comercial/financeiro";
import { COLUNAS_DO_RECEBIVEL } from "@/lib/schemas/financeiro";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "financial_receivables" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  const supabase = await createClient();
  const { data: rec, error } = await supabase
    .from("financial_receivables")
    .select(COLUNAS_DO_RECEBIVEL)
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao ler o recebível.", 500, { requestId });
  if (!rec) return fail("not_found", "Recebível não encontrado.", 404, { requestId });
  const r = rec as unknown as {
    order_id: string | null;
    invoice_id: string | null;
    contact_id: string | null;
    valor_original_cents: number;
    vencimento: string;
    status: "aberto" | "parcial" | "pago" | "cancelado";
  };

  const { data: pagos } = await supabase
    .from("financial_payments")
    .select("id, valor_cents, pago_em, forma_pagamento, conta, observacao, created_at")
    .eq("organization_id", authz.org.orgId)
    .eq("receivable_id", id)
    .order("pago_em", { ascending: true });
  const lista = (pagos ?? []) as unknown as { valor_cents: number }[];
  const hoje = new Date().toISOString().slice(0, 10);
  const sit = situacaoDe(
    { status: r.status, valor_original_cents: r.valor_original_cents, vencimento: r.vencimento },
    lista,
    hoje,
  );

  const [contato, pedido, nota] = await Promise.all([
    r.contact_id
      ? supabase.from("contacts").select("id, display_name, name").eq("id", r.contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
    r.order_id
      ? supabase.from("commercial_orders").select("id, numero, cliente_nome, status, total_cents").eq("id", r.order_id).maybeSingle()
      : Promise.resolve({ data: null }),
    r.invoice_id
      ? supabase.from("invoices").select("id, numero, serie, status").eq("id", r.invoice_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return ok(
    {
      ...(rec as unknown as Record<string, unknown>),
      situacao: sit.situacao,
      pago_cents: sit.pago_cents,
      saldo_cents: sit.saldo_cents,
      dias_atraso: sit.diasAtraso,
      pagamentos: pagos ?? [],
      contato: contato.data ?? null,
      pedido: pedido.data ?? null,
      nota: nota.data ?? null,
    },
    { requestId },
  );
}
