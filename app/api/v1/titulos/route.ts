/**
 * GET /api/v1/titulos — contas a receber derivadas dos pedidos (leitura: viewer+).
 *
 * Sem tabela própria de propósito: o título é a parcela do pedido faturado
 * (`calcularParcelas` sobre a condição de pagamento). Quando a condição não
 * gera parcelas, o vencimento é a emissão (à vista) — documentado na linha,
 * nunca adivinhado. Baixa de verdade (pago/não-pago) é fase futura com tabela
 * própria; hoje a situação é vencido x a vencer pela data.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { calcularParcelas } from "@/lib/schemas/pedidos";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export interface Titulo {
  order_id: string;
  numero: number;
  cliente_nome: string;
  parcela: number;
  de: number;
  vencimento: string;
  valor_cents: number;
  situacao: "vencido" | "a_vencer";
  condicao_pagamento: string | null;
  avista: boolean;
  baixado_em: string | null;
}

const TITULOS_STATUS = ["faturado", "expedido", "entregue"];

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "commercial_orders" });
  if (!authz.ok) return authz.response;

  const situacao = req.nextUrl.searchParams.get("situacao")?.trim() ?? "";
  if (situacao !== "" && situacao !== "vencido" && situacao !== "a_vencer") {
    return fail("validation_failed", "situacao aceita: vencido, a_vencer.", 422, { requestId });
  }

  const hoje = new Date().toISOString().slice(0, 10);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("commercial_orders")
    .select("id, numero, cliente_nome, total_cents, condicao_pagamento, created_at")
    .eq("organization_id", authz.org.orgId)
    .in("status", TITULOS_STATUS)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) return fail("internal_error", "Erro ao ler os pedidos.", 500, { requestId });

  const titulos: Titulo[] = [];
  const baixas = new Map<string, string>();
  const idsPedidos = ((data ?? []) as { id: string }[]).map((p) => p.id);
  if (idsPedidos.length > 0) {
    const { data: baixasDb } = await supabase
      .from("commercial_titulo_baixas")
      .select("order_id, parcela_n, baixado_em")
      .eq("organization_id", authz.org.orgId)
      .in("order_id", idsPedidos);
    for (const b of (baixasDb ?? []) as { order_id: string; parcela_n: number; baixado_em: string }[]) {
      baixas.set(`${b.order_id}#${b.parcela_n}`, b.baixado_em);
    }
  }
  const baixaDe = (orderId: string, parcela: number): string | null =>
    baixas.get(`${orderId}#${parcela}`) ?? null;
  for (const p of (data ?? []) as {
    id: string; numero: number; cliente_nome: string; total_cents: number;
    condicao_pagamento: string | null; created_at: string;
  }[]) {
    const parcelas = calcularParcelas(p.total_cents, p.condicao_pagamento);
    if (parcelas.length === 0) {
      const vencimento = p.created_at.slice(0, 10);
      const sit = vencimento < hoje ? "vencido" : "a_vencer";
      if (!situacao || situacao === sit) {
        titulos.push({
          order_id: p.id, numero: p.numero, cliente_nome: p.cliente_nome,
          parcela: 1, de: 1, vencimento, valor_cents: p.total_cents, situacao: sit,
          condicao_pagamento: p.condicao_pagamento, avista: true, baixado_em: baixaDe(p.id, 1),
        });
      }
      continue;
    }
    parcelas.forEach((pa) => {
      const sit = pa.vencimento < hoje ? "vencido" : "a_vencer";
      if (situacao && situacao !== sit) return;
      titulos.push({
        order_id: p.id, numero: p.numero, cliente_nome: p.cliente_nome,
        parcela: pa.n, de: parcelas.length, vencimento: pa.vencimento, valor_cents: pa.valor_cents,
        situacao: sit as Titulo["situacao"], condicao_pagamento: p.condicao_pagamento, avista: false,
        baixado_em: baixaDe(p.id, pa.n),
      });
    });
  }

  return ok(titulos, { requestId });
}
