/**
 * GET   /api/v1/shipments/[id] — a carga com os pedidos em ordem de rota.
 * PATCH /api/v1/shipments/[id] — muda status/veículo/motorista.
 *         Sair de `montando` para `em_rota` vira os itens para `em_rota`
 *         junto; concluir exige zero pendência (tudo entregue ou devolvido).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { cargaPatchSchema, COLUNAS_DA_CARGA } from "@/lib/schemas/expedicao";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

async function detalhe(supabase: Awaited<ReturnType<typeof createClient>>, orgId: string, id: string) {
  const { data: carga, error: erroCarga } = await supabase
    .from("shipments")
    .select(COLUNAS_DA_CARGA)
    .eq("id", id)
    .eq("organization_id", orgId)
    .single();
  if (erroCarga || !carga) return { erro: true as const };

  const { data: itens, error: erroItens } = await supabase
    .from("shipment_orders")
    .select("id, order_id, sequencia, status")
    .eq("shipment_id", id)
    .eq("organization_id", orgId)
    .order("sequencia");
  if (erroItens) return { erro: true as const };

  const ids = (itens ?? []).map((i) => (i as unknown as { order_id: string }).order_id);
  let pedidos: Record<string, unknown> = {};
  if (ids.length > 0) {
    const { data } = await supabase
      .from("commercial_orders")
      .select("id, numero, cliente_nome, endereco_entrega, total_cents, status")
      .eq("organization_id", orgId)
      .in("id", ids);
    pedidos = Object.fromEntries(
      ((data ?? []) as unknown as { id: string }[]).map((p) => [p.id, p]),
    );
  }
  const { data: provas } = await supabase
    .from("shipment_proofs")
    .select("order_id")
    .eq("shipment_id", id)
    .eq("organization_id", orgId);
  const comProva = new Set(((provas ?? []) as unknown as { order_id: string }[]).map((p) => p.order_id));

  // Pago antecipado por pedido (recebível quitado antes da rota): alimenta o
  // "a cobrar" dos cards e do fechamento — uma busca para a carga inteira.
  const pagoPorPedido: Record<string, number> = {};
  if (ids.length > 0) {
    const { data: recebiveis } = await supabase
      .from("financial_receivables")
      .select("order_id, valor_original_cents")
      .eq("organization_id", orgId)
      .in("order_id", ids)
      .eq("status", "pago");
    for (const r of ((recebiveis ?? []) as unknown as { order_id: string; valor_original_cents: number }[])) {
      pagoPorPedido[r.order_id] = (pagoPorPedido[r.order_id] ?? 0) + r.valor_original_cents;
    }
  }

  return {
    carga,
    itens: (itens ?? []).map((i) => {
      const r = i as unknown as { id: string; order_id: string; sequencia: number; status: string };
      return {
        ...r,
        pedido: pedidos[r.order_id] ?? null,
        tem_comprovante: comProva.has(r.order_id),
        pago_cents: pagoPorPedido[r.order_id] ?? 0,
      };
    }),
  };
}

export async function GET(_req: NextRequest, { params }: Params): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "shipments" });
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const supabase = await createClient();
  const d = await detalhe(supabase, authz.org.orgId, id);
  if ("erro" in d) return fail("not_found", "Carga não encontrada.", 404, { requestId });
  return ok(d, { requestId });
}

export async function PATCH(req: NextRequest, { params }: Params): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "shipments" });
  if (!authz.ok) return authz.response;

  const parsed = cargaPatchSchema.safeParse(await req.json().catch(() => null));
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

  const antes = await detalhe(supabase, authz.org.orgId, id);
  if ("erro" in antes) return fail("not_found", "Carga não encontrada.", 404, { requestId });
  const statusAtual = (antes.carga as unknown as { status: string }).status;

  // Regras de transição (a máquina é pequena e mora aqui, legível):
  // - sair de montando para em_rota: vira os itens junto;
  // - concluir: só sem pendência (na_carga/em_rota abertos);
  // - carga concluída/cancelada não reabre (histórico não se reescreve).
  if (parsed.data.status) {
    if (statusAtual === "concluida" || statusAtual === "cancelada") {
      return fail("validation_failed", "Carga encerrada não muda de status.", 422, { requestId });
    }
    if (parsed.data.status === "concluida") {
      // em_atendimento é pendência: chegou ≠ entregue.
      const pendentes = antes.itens.filter((i) =>
        ["na_carga", "em_rota", "em_atendimento"].includes(i.status),
      );
      if (pendentes.length > 0) {
        return fail(
          "validation_failed",
          `${pendentes.length} pedido(s) ainda sem desfecho (entregue ou devolvido).`,
          422,
          { requestId },
        );
      }
    }
  }

  const { data, error } = await supabase
    .from("shipments")
    .update(parsed.data)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select(COLUNAS_DA_CARGA)
    .single();

  if (error || !data) return fail("not_found", "Carga não encontrada.", 404, { requestId });

  if (parsed.data.status === "em_rota" && statusAtual === "montando") {
    await supabase
      .from("shipment_orders")
      .update({ status: "em_rota" })
      .eq("shipment_id", id)
      .eq("organization_id", authz.org.orgId)
      .eq("status", "na_carga");
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "shipment.updated",
    resourceType: "shipments",
    resourceId: id,
    requestId,
  });

  return ok(data, { requestId });
}

export async function DELETE(_req: NextRequest, { params }: Params): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "shipments" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  const supabase = await createClient();
  const antes = await detalhe(supabase, authz.org.orgId, id);
  if ("erro" in antes) return fail("not_found", "Carga não encontrada.", 404, { requestId });
  const statusAtual = (antes.carga as unknown as { status: string }).status;
  // Histórico não se apaga: concluída/cancelada ficam para auditoria.
  if (statusAtual === "concluida" || statusAtual === "cancelada") {
    return fail("validation_failed", "Carga encerrada não pode ser excluída.", 422, { requestId });
  }

  // Os itens caem juntos (FK on delete cascade); os pedidos voltam sozinhos
  // para "esperando carga", porque a lista de embarcáveis é pedido faturado
  // fora de carga — nada para "devolver" manualmente.
  const { error } = await supabase
    .from("shipments")
    .delete()
    .eq("id", id)
    .eq("organization_id", authz.org.orgId);
  if (error) return fail("internal_error", "Erro ao excluir a carga.", 500, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "shipment.deleted",
    resourceType: "shipments",
    resourceId: id,
    requestId,
  });

  return ok({ id }, { requestId });
}
