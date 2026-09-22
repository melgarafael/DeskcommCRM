/**
 * PATCH /api/v1/shipments/[id]/orders/[orderId] — o desfecho da entrega.
 *
 * `{ status: "em_atendimento" }` = cheguei (chegar perto não entrega
 * sozinho); `{ status: "entregue", latitude?, longitude? }` carimba
 * onde/quando; `{ status: "devolvido", motivo }` exige o motivo (sem motivo,
 * sem baixa). Confirmar entrega avança o pedido comercial para `entregue`
 * junto (a integração mora aqui, explícita — não em trigger escondido).
 * Devolução não mexe no pedido: ele volta para a operação decidir.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { MOTIVOS_DEVOLUCAO } from "@/lib/schemas/expedicao";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const corpoSchema = z
  .object({
    status: z.enum(["em_atendimento", "entregue", "devolvido"]),
    motivo: z.enum(MOTIVOS_DEVOLUCAO).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    /**
     * Quando aconteceu de verdade (ISO-8601). O app do entregador trabalha
     * offline: marca na hora, envia depois. Sem isto, tudo que chegasse
     * atrasado seria carimbado com a hora do ENVIO — mentira no histórico.
     */
    ocorrido_em: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.status === "devolvido" && !v.motivo) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Devolução pede o motivo.", path: ["motivo"] });
    }
    if (v.ocorrido_em) {
      const quando = new Date(v.ocorrido_em).getTime();
      const agora = Date.now();
      if (Number.isNaN(quando)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ocorrido_em inválido.", path: ["ocorrido_em"] });
      } else if (quando > agora + 5 * 60 * 1000) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ocorrido_em está no futuro.", path: ["ocorrido_em"] });
      } else if (quando < agora - 7 * 24 * 3600 * 1000) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "ocorrido_em muito antigo (limite de 7 dias).",
          path: ["ocorrido_em"],
        });
      }
    }
  });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; orderId: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "shipment_orders" });
  if (!authz.ok) return authz.response;

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const { id, orderId } = await params;
  const supabase = await createClient();

  const { data: item, error: erroItem } = await supabase
    .from("shipment_orders")
    .select("id, status")
    .eq("shipment_id", id)
    .eq("order_id", orderId)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();

  if (erroItem || !item) {
    return fail("not_found", "Pedido não está nesta carga.", 404, { requestId });
  }

  const { data: atualizado, error: erroUpd } = await supabase
    .from("shipment_orders")
    .update({
      status: parsed.data.status,
      ...(parsed.data.status === "devolvido" ? { motivo: parsed.data.motivo ?? null } : {}),
      ...(parsed.data.status === "entregue"
        ? {
            // Offline: vale a hora do fato, não a do envio.
            entregue_em: parsed.data.ocorrido_em ?? new Date().toISOString(),
            ...(parsed.data.latitude != null ? { entregue_lat: parsed.data.latitude } : {}),
            ...(parsed.data.longitude != null ? { entregue_lng: parsed.data.longitude } : {}),
          }
        : {}),
    })
    .eq("shipment_id", id)
    .eq("order_id", orderId)
    .eq("organization_id", authz.org.orgId)
    .select("id, order_id, sequencia, status")
    .single();

  if (erroUpd || !atualizado) {
    return fail("internal_error", "Erro ao registrar a entrega.", 500, { requestId });
  }

  if (parsed.data.status === "entregue") {
    await supabase
      .from("commercial_orders")
      .update({ status: "entregue" })
      .eq("id", orderId)
      .eq("organization_id", authz.org.orgId);
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "shipment_order.status",
    resourceType: "shipment_orders",
    resourceId: (atualizado as unknown as { id: string }).id,
    requestId,
  });

  return ok(atualizado, { requestId });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; orderId: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "shipment_orders" });
  if (!authz.ok) return authz.response;

  const { id, orderId } = await params;
  const supabase = await createClient();

  const { data: item } = await supabase
    .from("shipment_orders")
    .select("id, status")
    .eq("shipment_id", id)
    .eq("order_id", orderId)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!item) return fail("not_found", "Pedido não está nesta carga.", 404, { requestId });
  const st = (item as unknown as { status: string }).status;
  // Entregue/devolvido é histórico da rota — não sai; volta pela operação.
  if (st !== "na_carga" && st !== "em_rota") {
    return fail("validation_failed", "Só pedido ainda na carga pode sair dela.", 422, { requestId });
  }

  const { error } = await supabase
    .from("shipment_orders")
    .delete()
    .eq("shipment_id", id)
    .eq("order_id", orderId)
    .eq("organization_id", authz.org.orgId);
  if (error) return fail("internal_error", "Erro ao tirar o pedido da carga.", 500, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "shipment_order.removed",
    resourceType: "shipment_orders",
    resourceId: (item as unknown as { id: string }).id,
    requestId,
  });

  return ok({ order_id: orderId }, { requestId });
}
