/**
 * GET  /api/v1/commercial-orders — pedidos comerciais da organização ativa.
 * POST /api/v1/commercial-orders — cria um pedido com itens.
 *
 * Os pedidos que a LOJA possui (tabela `commercial_orders`, 0208) — distintos
 * de `orders`, que é espelho da Nuvemshop. Escrita de `agent` para cima:
 * vendedor e IA criam pedido; viewer não.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  COLUNAS_DO_PEDIDO,
  STATUS_DO_PEDIDO,
  pedidoCreateSchema,
} from "@/lib/schemas/pedidos";
import { criarPedidoComercial } from "@/lib/comercial/criar-pedido";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "commercial_orders" });
  if (!authz.ok) return authz.response;

  const params = req.nextUrl.searchParams;
  const status = params.get("status")?.trim() ?? "";
  const busca = params.get("busca")?.trim() ?? "";
  const origem = params.get("origem")?.trim() ?? "";
  const contato = params.get("contact_id")?.trim() ?? "";
  const condicao = params.get("condicao")?.trim() ?? "";
  const vendedor = params.get("vendedor_user_id")?.trim() ?? "";
  const valorMin = Number(params.get("valor_min") ?? "") || 0;
  const valorMax = Number(params.get("valor_max") ?? "") || 0;
  // Janela de datas para drill-down do dashboard. Aceita dia (`YYYY-MM-DD`,
  // dia UTC) ou instante ISO (`YYYY-MM-DDTHH:mm`) — o dashboard calcula os
  // limites UTC exatos do dia no fuso da org e passa instantes.
  const de = params.get("de")?.trim() ?? "";
  const ate = params.get("ate")?.trim() ?? "";
  const DIA = /^\d{4}-\d{2}-\d{2}$/;
  const INSTANTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/;

  const supabase = await createClient();
  let q = supabase
    .from("commercial_orders")
    .select(COLUNAS_DO_PEDIDO)
    .eq("organization_id", authz.org.orgId);

  if (status !== "" && (STATUS_DO_PEDIDO as readonly string[]).includes(status)) {
    q = q.eq("status", status);
  }
  if (origem !== "") q = q.eq("origem", origem);
  if (contato !== "") q = q.eq("contact_id", contato);
  if (condicao !== "") q = q.ilike("condicao_pagamento", `%${condicao}%`);
  if (vendedor !== "") q = q.eq("vendedor_user_id", vendedor);
  if (valorMin > 0) q = q.gte("total_cents", Math.round(valorMin * 100));
  if (valorMax > 0) q = q.lte("total_cents", Math.round(valorMax * 100));
  if (busca !== "") {
    q = q.or(`cliente_nome.ilike.%${busca}%,cliente_documento.ilike.%${busca}%`);
  }
  if (DIA.test(de)) q = q.gte("created_at", `${de}T00:00:00Z`);
  else if (INSTANTE.test(de)) q = q.gte("created_at", de);
  if (DIA.test(ate)) q = q.lt("created_at", `${ate}T23:59:59.999Z`);
  else if (INSTANTE.test(ate)) q = q.lt("created_at", ate);

  const { data, error } = await q.order("created_at", { ascending: false }).limit(200);

  if (error) return fail("internal_error", "Erro ao listar os pedidos.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "commercial_orders" });
  if (!authz.ok) return authz.response;

  const parsed = pedidoCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const entrada = parsed.data;

  // Override de estoque/crédito é poder de `manager` para cima. O gate
  // canônico decide — a rota nunca compara rank na mão (anti-padrão "matriz
  // advisória", ver require-role.ts). O resultado vira `podeIgnorar` do
  // serviço (a tool de IA passa sempre false).
  let podeIgnorar = false;
  if (entrada.ignorar_estoque || entrada.ignorar_credito) {
    const mgr = await requireRole("manager", { requestId, resource: "commercial_orders" });
    if (!mgr.ok) {
      return fail("validation_failed", "Só gerente pode ignorar estoque ou crédito.", 422, { requestId });
    }
    podeIgnorar = true;
  }

  const supabase = await createClient();
  const resultado = await criarPedidoComercial(supabase, createAdminClient(), {
    orgId: authz.org.orgId,
    userId: authz.user.id,
    podeIgnorar,
  }, entrada);

  if (!resultado.ok) {
    const status = resultado.code === "validation_failed" ? 422 : resultado.code === "conflict" ? 409 : 500;
    return fail(resultado.code === "conflict" ? "conflict" : resultado.code === "validation_failed" ? "validation_failed" : "internal_error", resultado.message, status, {
      requestId,
      ...(resultado.details ? { details: resultado.details } : {}),
    });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "commercial_order.created",
    resourceType: "commercial_orders",
    resourceId: (resultado.pedido as { id: string }).id,
    requestId,
  });

  return ok(
    { ...resultado.pedido, aprovacao_necessaria: resultado.aprovacao_necessaria },
    { requestId, status: 201 },
  );
}
