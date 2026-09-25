/**
 * Uma comanda: ler, dar desconto, cancelar.
 *
 * ⚠️ CANCELAR É STATUS, NUNCA DELETE. Uma comanda cancelada continua contando o
 * que aconteceu — quem abriu, quando, e o que chegou a ser lançado nela. É o
 * invariante 1 do módulo, e o schema o sustenta: `sale_items` cascateia por
 * `sale_id`, o que só é seguro porque a comanda não é apagada.
 *
 * ⚠️ COMANDA FINALIZADA NÃO ACEITA DESCONTO. Depois de finalizada ela já virou
 * lançamento no financeiro e, se houver, comissão e ponto de fidelidade. Mudar
 * o desconto ali deixaria os quatro números discordando em silêncio. O caminho
 * de desfazer é o ESTORNO, que faz contra-lançamento.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { alterarComandaSchema } from "@/lib/financeiro/comanda";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const { id } = await ctx.params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sales")
    // Literal único — ver a nota em `comandas/route.ts`.
    .select(
      "id, number, status, contact_id, attendant_user_id, appointment_id, discount_cents, total_cents, currency, payment_method_id, notes, finalized_at, cancelled_at, cancel_reason, reversed_at, reverse_reason, created_at, sale_items(id, description, quantity, unit_price_cents, discount_cents, total_cents, commission_percent, attendant_user_id, event_type_id, created_at)",
    )
    .eq("id", id)
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", "Comanda não encontrada.", 404, { requestId });

  const itens = (data.sale_items ?? []) as Array<{ total_cents: number }>;
  const soma = itens.reduce((acc, i) => acc + Number(i.total_cents), 0);
  return ok(
    {
      ...data,
      items_total_cents: soma,
      total_cents:
        data.status === "open"
          ? Math.max(soma - Number(data.discount_cents ?? 0), 0)
          : data.total_cents,
    },
    { requestId },
  );
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const lido = alterarComandaSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, {
      requestId,
    });
  }

  const { id } = await ctx.params;
  const supabase = await createClient();

  const { data: atual } = await supabase
    .from("sales")
    .select("id, status, number")
    .eq("id", id)
    .maybeSingle();
  if (!atual) return fail("not_found", "Comanda não encontrada.", 404, { requestId });

  if (atual.status !== "open") {
    return fail(
      "conflict",
      atual.status === "finalized"
        ? "Comanda já finalizada. Para desfazer, use o estorno."
        : "Comanda cancelada não aceita alteração.",
      409,
      { requestId },
    );
  }

  const mudanca: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (lido.data.discount_cents !== undefined) mudanca.discount_cents = lido.data.discount_cents;
  if (lido.data.notes !== undefined) mudanca.notes = lido.data.notes;
  if (lido.data.cancel) {
    mudanca.status = "cancelled";
    mudanca.cancelled_at = new Date().toISOString();
  }

  const { error } = await supabase.from("sales").update(mudanca).eq("id", id);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  // ⚠️ NUNCA espalhe o corpo lido aqui. `lib/audit` grava `metadata` CRU em
  // `api_audit_log`, sem sanitizador, com retenção de anos — e a cascata de
  // anonimização da LGPD NÃO alcança essa tabela: nenhum papel tem GRANT de
  // UPDATE/DELETE nela, nem `service_role`. O que entra fica para sempre, e o
  // spread carregava `notes`, que é texto livre que a equipe escreve SOBRE A
  // PESSOA ("cliente reclamou do resultado"). Um titular que peça anonimização
  // teria a comanda redigida e a frase intacta no audit, fora de alcance.
  //
  // O que o audit precisa saber é O QUE MUDOU, não o que foi escrito: campos
  // derivados respondem "quem alterou a observação da comanda 42?" sem gravar
  // a observação. Este é o padrão que o POST de abertura já segue.
  await audit({
    action: lido.data.cancel ? "comanda.cancelada" : "comanda.alterada",
    resourceType: "sale",
    resourceId: id,
    requestId,
    metadata: {
      number: atual.number,
      alterou_notes: lido.data.notes !== undefined,
      discount_cents: lido.data.discount_cents ?? null,
      cancelada: lido.data.cancel === true,
    },
  });

  return ok({ id, status: lido.data.cancel ? "cancelled" : "open" }, { requestId });
}
