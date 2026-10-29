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
import { itemSchema, totalDoItem } from "@/lib/financeiro/comanda";
import { percentualDoItem } from "@/lib/financeiro/comissao-do-item";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  // #1907 item 4 — comanda é MÓDULO DE TABELA: sem `modulos_instalados` a
  // linha ativa as cinco tabelas não existem e a rota não existe. 404,
  // mesmo molde da cobrança desligada (falha fechada, dois lados).
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "financeiro"))) return fail("not_found", "Not found", 404, { requestId });
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
    .select("id, status, number, attendant_user_id, calendar_appointments(owner_user_id)")
    .eq("id", id)
    .maybeSingle();
  if (!comanda) return fail("not_found", "Comanda não encontrada.", 404, { requestId });
  if (comanda.status !== "open") {
    return fail("conflict", "Só comanda aberta recebe item.", 409, { requestId });
  }

  // Sem atendente no corpo, vale o dono do agendamento da comanda e, sem ele, o
  // da comanda (quem a abriu). Item sem atendente não gera comissão em
  // `fn_finalizar_comanda`, e a tela do balcão não o manda. O dono vem antes de
  // quem abriu porque a recepção abre a comanda do serviço que outro prestou.
  const agendamento = Array.isArray(comanda.calendar_appointments)
    ? comanda.calendar_appointments[0]
    : comanda.calendar_appointments;
  const atendente =
    lido.data.attendant_user_id ?? agendamento?.owner_user_id ?? comanda.attendant_user_id ?? null;

  const percent = await percentualDoItem(supabase, org, {
    attendantUserId: atendente,
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
      attendant_user_id: atendente,
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
