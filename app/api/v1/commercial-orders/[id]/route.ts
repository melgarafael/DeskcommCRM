/**
 * GET   /api/v1/commercial-orders/[id] — pedido com itens.
 * PATCH /api/v1/commercial-orders/[id] — muda status, vendedor, condição,
 *         observações. Itens e totais NÃO mudam aqui: pedido faturado não se
 *         reescreve, se cancela e refaz (o histórico fiscal agradece).
 * DELETE /api/v1/commercial-orders/[id] — exclui (manager+). Devolve o
 *         estoque baixado, barra com NF vinculada ou embarque ativo.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { COLUNAS_DO_ITEM, COLUNAS_DO_PEDIDO, pedidoPatchSchema } from "@/lib/schemas/pedidos";
import { cabeNoCredito, situacaoDeCredito } from "@/lib/comercial/credito";
import { gerarRecebiveis } from "@/lib/comercial/financeiro";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "commercial_orders" });
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const supabase = await createClient();

  const { data: pedido, error: erroPedido } = await supabase
    .from("commercial_orders")
    .select(COLUNAS_DO_PEDIDO)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .single();

  if (erroPedido || !pedido) {
    return fail("not_found", "Pedido não encontrado.", 404, { requestId });
  }

  const { data: itens, error: erroItens } = await supabase
    .from("commercial_order_items")
    .select(COLUNAS_DO_ITEM)
    .eq("order_id", id)
    .eq("organization_id", authz.org.orgId)
    .order("posicao");

  if (erroItens) return fail("internal_error", "Erro ao ler os itens.", 500, { requestId });

  return ok({ ...(pedido as unknown as Record<string, unknown>), itens: itens ?? [] }, { requestId });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "commercial_orders" });
  if (!authz.ok) return authz.response;

  const parsed = pedidoPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  if (Object.keys(parsed.data).length === 0) {
    return fail("validation_failed", "Nada para atualizar.", 422, { requestId });
  }

  const { id } = await params;
  const supabase = await createClient();

  // Troca de cliente: o snapshot (nome/documento) acompanha o contact_id —
  // pedido impresso com nome de outro cliente seria dado corrompido.
  const atualizacao: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.contact_id !== undefined) {
    if (parsed.data.contact_id === null) {
      atualizacao.cliente_nome = "SEM CLIENTE";
      atualizacao.cliente_documento = null;
    } else {
      const { data: contato } = await supabase
        .from("contacts")
        .select("display_name, name, cnpj")
        .eq("id", parsed.data.contact_id)
        .eq("organization_id", authz.org.orgId)
        .maybeSingle();
      if (!contato) {
        return fail("validation_failed", "Cliente não encontrado.", 422, { requestId });
      }
      const c = contato as unknown as { display_name: string | null; name: string | null; cnpj: string | null };
      atualizacao.cliente_nome = (c.display_name ?? c.name ?? "SEM NOME").slice(0, 200);
      atualizacao.cliente_documento = c.cnpj;
    }
  }

  // Aprovar (em_analise → aprovado) é poder de `manager`: é o gate do
  // workflow de aprovação (§15). As demais transições seguem agent+.
  // E sair do rascunho com desconto acima do teto ESCALA para em_analise
  // (mesma regra do POST): sem isso, aprovar o rascunho passava por baixo
  // da trava de desconto.
  if (parsed.data.status && parsed.data.status !== "rascunho" && parsed.data.status !== "cancelado") {
    const { data: atual } = await supabase
      .from("commercial_orders")
      .select("status, subtotal_cents, desconto_cents, desconto_pct")
      .eq("id", id)
      .eq("organization_id", authz.org.orgId)
      .maybeSingle();
    const ordem = atual as unknown as {
      status: string;
      subtotal_cents: number;
      desconto_cents: number;
      desconto_pct: number | null;
    } | null;
    if (ordem && (ordem.status === "rascunho" || ordem.status === "em_analise")) {
      const { data: polDb } = await supabase
        .from("commercial_policies")
        .select("desconto_max_vendedor_pct")
        .eq("organization_id", authz.org.orgId)
        .maybeSingle();
      const teto = Number(
        (polDb as unknown as { desconto_max_vendedor_pct: number } | null)?.desconto_max_vendedor_pct ?? 5,
      );
      const { data: itensDb } = await supabase
        .from("commercial_order_items")
        .select("desconto_pct")
        .eq("order_id", id)
        .eq("organization_id", authz.org.orgId);
      const maxItem = Math.max(
        0,
        ...((itensDb ?? []) as unknown as { desconto_pct: number }[]).map((i) => Number(i.desconto_pct)),
      );
      // R$ vira % sobre o subtotal para comparar com o mesmo teto do POST.
      const pctDoValor = ordem.subtotal_cents > 0 ? (ordem.desconto_cents / ordem.subtotal_cents) * 100 : 0;
      const maior = Math.max(maxItem, ordem.desconto_pct ?? 0, pctDoValor);
      if (parsed.data.status === "aprovado" && maior > teto) {
        const mgr = await requireRole("manager", { requestId, resource: "commercial_orders" });
        if (!mgr.ok) {
          parsed.data.status = "em_analise";
        }
      }
      if (ordem.status === "em_analise" && parsed.data.status === "aprovado") {
        const mgr = await requireRole("manager", { requestId, resource: "commercial_orders" });
        if (!mgr.ok) {
          return fail("validation_failed", "Só gerente aprova pedido em análise.", 422, { requestId });
        }
      }
    }
  }

  // Aprovar um rascunho o torna compromisso: valida o crédito como o POST
  // faz. Sem isso, o bloqueio nasceria furado — era só salvar rascunho e
  // aprovar depois para passar por baixo da regra.
  if (parsed.data.status && parsed.data.status !== "rascunho" && parsed.data.status !== "cancelado") {
    const { data: atual } = await supabase
      .from("commercial_orders")
      .select("status, contact_id, total_cents")
      .eq("id", id)
      .eq("organization_id", authz.org.orgId)
      .maybeSingle();
    const ordem = atual as unknown as {
      status: string;
      contact_id: string | null;
      total_cents: number;
    } | null;
    if (ordem && ordem.status === "rascunho" && ordem.contact_id) {
      const situacao = await situacaoDeCredito(supabase, authz.org.orgId, ordem.contact_id);
      if (!cabeNoCredito(situacao, ordem.total_cents)) {
        return fail("validation_failed", "Cliente acima do limite de crédito.", 422, {
          requestId,
          details: {
            limite_cents: situacao.limite_cents,
            em_aberto_cents: situacao.em_aberto_cents,
          },
        });
      }
    }
  }

  const { data, error } = await supabase
    .from("commercial_orders")
    .update(atualizacao)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select(COLUNAS_DO_PEDIDO)
    .single();

  if (error || !data) {
    return fail("not_found", "Pedido não encontrado.", 404, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "commercial_order.updated",
    resourceType: "commercial_orders",
    resourceId: id,
    requestId,
  });

  // Faturar gera os recebíveis (idempotente: re-PATCH não duplica). Best
  // effort de propósito: o pedido já foi atualizado acima — financeiro que
  // falha aqui aparece na conciliação (pedido_sem_financeiro) em vez de
  // derrubar o faturamento.
  if (parsed.data.status === "faturado") {
    const f = data as unknown as {
      contact_id: string | null;
      total_cents: number;
      condicao_pagamento: string | null;
      created_at: string;
    };
    try {
      await gerarRecebiveis(createAdminClient(), {
        orgId: authz.org.orgId,
        orderId: id,
        contactId: f.contact_id,
        totalCents: f.total_cents,
        condicao: f.condicao_pagamento,
        baseIso: f.created_at,
        criadoPor: authz.user.id,
      });
    } catch (e) {
      console.error(`[commercial-orders] gerar financeiro falhou para ${id}`, e instanceof Error ? e.message : e);
    }
  }

  return ok(data, { requestId });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "commercial_orders" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  const supabase = await createClient();
  const { data: pedido } = await supabase
    .from("commercial_orders")
    .select("id, numero, status")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!pedido) return fail("not_found", "Pedido não encontrado.", 404, { requestId });
  const ped = pedido as unknown as { id: string; numero: number; status: string };

  // NF vinculada é fato fiscal: não se apaga, se cancela o pedido.
  const { count: nfs } = await supabase
    .from("invoices")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", authz.org.orgId)
    .eq("order_id", id);
  if ((nfs ?? 0) > 0) {
    return fail("validation_failed", "Pedido com nota fiscal não pode ser excluído — cancele o pedido.", 422, {
      requestId,
    });
  }

  // Embarcado trava no FK (restrict): manda tirar da carga primeiro, com nome.
  const { count: embarques } = await supabase
    .from("shipment_orders")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", authz.org.orgId)
    .eq("order_id", id);
  if ((embarques ?? 0) > 0) {
    return fail("validation_failed", "Pedido está em uma carga — tire da carga antes de excluir.", 422, {
      requestId,
    });
  }

  // Devolve o estoque baixado na criação (rascunho nunca baixou).
  if (ped.status !== "rascunho") {
    const { data: itens } = await supabase
      .from("commercial_order_items")
      .select("product_id, quantidade")
      .eq("order_id", id)
      .eq("organization_id", authz.org.orgId);
    const admin = createAdminClient();
    for (const it of ((itens ?? []) as unknown as { product_id: string | null; quantidade: number }[])) {
      if (!it.product_id) continue;
      const { data: prod } = await admin
        .from("catalog_products")
        .select("quantidade, controla_estoque")
        .eq("id", it.product_id)
        .eq("organization_id", authz.org.orgId)
        .maybeSingle();
      const p = prod as unknown as { quantidade: number; controla_estoque: boolean } | null;
      if (!p?.controla_estoque) continue;
      await admin
        .from("catalog_products")
        .update({ quantidade: p.quantidade + it.quantidade })
        .eq("id", it.product_id)
        .eq("organization_id", authz.org.orgId);
    }
  }

  const { error } = await supabase
    .from("commercial_orders")
    .delete()
    .eq("id", id)
    .eq("organization_id", authz.org.orgId);
  if (error) return fail("internal_error", "Erro ao excluir o pedido.", 500, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "commercial_order.deleted",
    resourceType: "commercial_orders",
    resourceId: id,
    requestId,
    metadata: { actor_type: "user", numero: ped.numero },
  });

  return ok({ id }, { requestId });
}
