/**
 * GET /api/v1/faturamento — pedidos faturados com a NF vinculada (leitura: viewer+).
 *
 * Espelha o relatório de Pedidos Faturados do Mercos: data, NF, pedido,
 * cliente, vendedor, total e valor faturado. A NF vem de `invoices`
 * (order_id); pedido faturado sem nota aparece com NF vazia — que é o sinal
 * de cobrança que faltava, não um erro.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export interface LinhaFaturamento {
  order_id: string;
  numero: number;
  data_emissao: string;
  cliente_nome: string;
  vendedor_user_id: string | null;
  total_cents: number;
  nf_serie: string | null;
  nf_numero: number | null;
  nf_status: string | null;
}

const DIA = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "commercial_orders" });
  if (!authz.ok) return authz.response;

  const de = req.nextUrl.searchParams.get("de")?.trim() ?? "";
  const ate = req.nextUrl.searchParams.get("ate")?.trim() ?? "";
  if ((de && !DIA.test(de)) || (ate && !DIA.test(ate))) {
    return fail("validation_failed", "Use ?de=AAAA-MM-DD&ate=AAAA-MM-DD.", 422, { requestId });
  }

  const supabase = await createClient();
  let q = supabase
    .from("commercial_orders")
    .select("id, numero, cliente_nome, vendedor_user_id, total_cents, created_at")
    .eq("organization_id", authz.org.orgId)
    .in("status", ["faturado", "expedido", "entregue"])
    .order("created_at", { ascending: false })
    .limit(2000);
  if (de) q = q.gte("created_at", `${de}T00:00:00Z`);
  if (ate) q = q.lt("created_at", `${ate}T00:00:00Z`);
  const { data: pedidos, error: erroPedidos } = await q;
  if (erroPedidos) return fail("internal_error", "Erro ao ler os pedidos.", 500, { requestId });

  const ids = ((pedidos ?? []) as { id: string }[]).map((p) => p.id);
  let notas = new Map<string, { serie: string; numero: number | null; status: string }>();
  if (ids.length > 0) {
    const { data: nfs } = await supabase
      .from("invoices")
      .select("order_id, serie, numero, status")
      .eq("organization_id", authz.org.orgId)
      .in("order_id", ids);
    notas = new Map(
      ((nfs ?? []) as { order_id: string; serie: string; numero: number | null; status: string }[]).map((n) => [
        n.order_id,
        { serie: n.serie, numero: n.numero, status: n.status },
      ]),
    );
  }

  const linhas: LinhaFaturamento[] = ((pedidos ?? []) as {
    id: string; numero: number; cliente_nome: string; vendedor_user_id: string | null;
    total_cents: number; created_at: string;
  }[]).map((p) => {
    const nf = notas.get(p.id);
    return {
      order_id: p.id,
      numero: p.numero,
      data_emissao: p.created_at,
      cliente_nome: p.cliente_nome,
      vendedor_user_id: p.vendedor_user_id,
      total_cents: p.total_cents,
      nf_serie: nf?.serie ?? null,
      nf_numero: nf?.numero ?? null,
      nf_status: nf?.status ?? null,
    };
  });

  return ok(linhas, { requestId });
}
