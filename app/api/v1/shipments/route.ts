/**
 * GET  /api/v1/shipments — cargas da organização ativa.
 * POST /api/v1/shipments — cria uma carga com pedidos (romaneio).
 *
 * Só pedido comprometido embarca (em_analise/aprovado/faturado/expedido):
 * rascunho é intenção, entregue/cancelado é passado. A rota confere um a um
 * e recusa a carga inteira no primeiro inelegível — carga parcial silenciosa
 * faria o expedidor achar que levou o que ficou para trás.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  cargaCreateSchema,
  COLUNAS_DA_CARGA,
  STATUS_DA_CARGA,
  STATUS_EMBARCAVEIS,
} from "@/lib/schemas/expedicao";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "shipments" });
  if (!authz.ok) return authz.response;

  const status = req.nextUrl.searchParams.get("status")?.trim() ?? "";
  const supabase = await createClient();
  let q = supabase
    .from("shipments")
    .select(COLUNAS_DA_CARGA)
    .eq("organization_id", authz.org.orgId);

  if (status !== "" && (STATUS_DA_CARGA as readonly string[]).includes(status)) {
    q = q.eq("status", status);
  }

  const { data, error } = await q.order("created_at", { ascending: false }).limit(200);
  if (error) return fail("internal_error", "Erro ao listar as cargas.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "shipments" });
  if (!authz.ok) return authz.response;

  const parsed = cargaCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const entrada = parsed.data;
  const ids = [...new Set(entrada.order_ids)];

  const supabase = await createClient();

  // Elegibilidade + existência, um a um, antes de criar qualquer coisa.
  if (ids.length > 0) {
    const { data: pedidos, error } = await supabase
      .from("commercial_orders")
      .select("id, numero, status")
      .eq("organization_id", authz.org.orgId)
      .in("id", ids);
    if (error) return fail("internal_error", "Erro ao ler os pedidos.", 500, { requestId });
    const porId = new Map((pedidos ?? []).map((p) => [(p as unknown as { id: string }).id, p]));
    for (const pid of ids) {
      const ped = porId.get(pid) as unknown as { numero: number; status: string } | undefined;
      if (!ped) {
        return fail("validation_failed", "Um dos pedidos não existe.", 422, { requestId });
      }
      if (!(STATUS_EMBARCAVEIS as readonly string[]).includes(ped.status)) {
        return fail(
          "validation_failed",
          `Pedido PED-${String(ped.numero).padStart(4, "0")} está "${ped.status}" — só embarcável aprovado/faturado.`,
          422,
          { requestId },
        );
      }
    }
    // Já embarcado em outra carga?
    const { data: ocupados } = await supabase
      .from("shipment_orders")
      .select("order_id")
      .eq("organization_id", authz.org.orgId)
      .in("order_id", ids);
    if (ocupados && ocupados.length > 0) {
      return fail("validation_failed", "Um dos pedidos já está em outra carga.", 409, { requestId });
    }
  }

  const { data: numero, error: erroNumero } = await supabase.rpc("fn_proximo_numero_carga", {
    p_org: authz.org.orgId,
  });
  if (erroNumero || typeof numero !== "number") {
    return fail("internal_error", "Erro ao numerar a carga.", 500, { requestId });
  }

  const { data: carga, error: erroCarga } = await supabase
    .from("shipments")
    .insert({
      organization_id: authz.org.orgId,
      numero,
      placa: entrada.placa || null,
      veiculo_tipo: entrada.veiculo_tipo ?? null,
      motorista_nome: entrada.motorista_nome ?? null,
      status: "montando",
      created_by: authz.user.id,
    })
    .select(COLUNAS_DA_CARGA)
    .single();

  if (erroCarga || !carga) {
    return fail("internal_error", "Erro ao salvar a carga.", 500, { requestId });
  }
  const cargaId = (carga as unknown as { id: string }).id;

  if (ids.length > 0) {
    const { error: erroItens } = await supabase.from("shipment_orders").insert(
      ids.map((order_id, i) => ({
        organization_id: authz.org.orgId,
        shipment_id: cargaId,
        order_id,
        sequencia: i + 1,
        status: "na_carga",
      })),
    );
    if (erroItens) {
      await supabase.from("shipments").delete().eq("id", cargaId);
      return fail("internal_error", "Erro ao embarcar os pedidos.", 500, { requestId });
    }
    // Quem embarcou sai da fila: avança para `expedido`, e a lista de
    // "aguardando embarque" (só aprovado/faturado) deixa de mostrá-lo.
    // Só avança — nunca regride: se o pedido mudou de status na concorrência,
    // o filtro protege.
    await supabase
      .from("commercial_orders")
      .update({ status: "expedido" })
      .eq("organization_id", authz.org.orgId)
      .in("id", ids)
      .in("status", [...STATUS_EMBARCAVEIS]);
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "shipment.created",
    resourceType: "shipments",
    resourceId: cargaId,
    requestId,
  });

  return ok({ ...(carga as unknown as Record<string, unknown>), numero }, { requestId, status: 201 });
}
