/**
 * Os itens da comanda.
 *
 * ⚠️ A COMISSÃO É RESOLVIDA AQUI, NA INCLUSÃO, e gravada na linha.
 * `fn_finalizar_comanda` não consulta `commission_rules` de propósito: mudar a
 * regra amanhã não pode mexer no que foi combinado ontem. Se este cálculo
 * deixasse de acontecer, o item entraria com 0% e ninguém veria — a comanda
 * fecha, o dinheiro entra, e só falta a comissão de quem atendeu.
 *
 * ⚠️ SÓ COMANDA ABERTA RECEBE ITEM. Depois de finalizada, acrescentar item
 * deixaria o total da venda, o lançamento do financeiro e a comissão já gerada
 * discordando entre si, sem nada reclamar.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { itemSchema, percentualDaComissao, totalDoItem } from "@/lib/financeiro/comanda";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const lido = itemSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, {
      requestId,
    });
  }

  const { id } = await ctx.params;
  const supabase = await createClient();
  const org = authz.org.orgId;

  const { data: comanda } = await supabase
    .from("sales")
    .select("id, status, number")
    .eq("id", id)
    .maybeSingle();
  if (!comanda) return fail("not_found", "Comanda não encontrada.", 404, { requestId });
  if (comanda.status !== "open") {
    return fail("conflict", "Só comanda aberta recebe item.", 409, { requestId });
  }

  // Só regra EM VIGOR. Uma regra inativada continua na tabela para explicar o
  // percentual de uma comanda antiga (é o motivo de ela inativar em vez de
  // sumir), e deixá-la participar da resolução de hoje faria "desligar a regra"
  // não desligar nada.
  const { data: regras } = await supabase
    .from("commission_rules")
    .select("attendant_user_id, event_type_id, percent")
    .eq("organization_id", org)
    .eq("is_active", true);

  const percent = percentualDaComissao(regras ?? [], {
    attendantUserId: lido.data.attendant_user_id ?? null,
    eventTypeId: lido.data.event_type_id ?? null,
  });

  const total = totalDoItem({
    quantidade: lido.data.quantity,
    precoUnitarioCents: lido.data.unit_price_cents,
    descontoCents: lido.data.discount_cents,
  });

  const { data, error } = await supabase
    .from("sale_items")
    .insert({
      organization_id: org,
      sale_id: id,
      event_type_id: lido.data.event_type_id ?? null,
      description: lido.data.description,
      attendant_user_id: lido.data.attendant_user_id ?? null,
      quantity: lido.data.quantity,
      unit_price_cents: lido.data.unit_price_cents,
      discount_cents: lido.data.discount_cents,
      total_cents: total,
      commission_percent: percent,
    })
    .select("id, description, quantity, unit_price_cents, discount_cents, total_cents, commission_percent")
    .single();

  if (error) return fail("internal_error", error.message, 500, { requestId });

  await audit({
    action: "comanda.item_incluido",
    resourceType: "sale",
    resourceId: id,
    requestId,
    metadata: { number: comanda.number, item_id: data.id, total_cents: total, commission_percent: percent },
  });

  return ok(data, { requestId });
}
