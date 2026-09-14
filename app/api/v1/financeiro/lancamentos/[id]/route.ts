/**
 * Um lançamento: pagar, ou apagar enquanto ainda não é dinheiro.
 *
 * ⚠️ PAGO É IMUTÁVEL, e quem garante isso é o TRIGGER
 * `fn_lancamento_pago_e_imutavel`, não esta rota. As checagens aqui existem para
 * a recusa chegar com nome e em português; se alguém contornar a rota, o banco
 * continua recusando.
 *
 * ⚠️ DELETE SÓ DE PENDENTE, e é o mesmo raciocínio do item de comanda aberta: um
 * lançamento pendente ainda não é dinheiro que passou. Depois de pago ele é
 * história, e o caminho de desfazer é um contra-lançamento — nunca o delete.
 *
 * ⚠️ LANÇAMENTO DE COMANDA NÃO SE MEXE POR AQUI. `origin <> 'manual'` é recusado
 * mesmo quando pendente: quem o criou foi a finalização, e apagá-lo deixaria a
 * comanda finalizada sem a entrada correspondente — os dois números divergindo
 * em silêncio, que é exatamente o que o módulo inteiro existe para impedir.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const alterarSchema = z.object({
  /** O único caminho de mudança: pendente vira pago. Nunca o contrário. */
  pay: z.literal(true),
});

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const lido = alterarSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", "Só é possível marcar como pago.", 422, { requestId });
  }

  const { id } = await ctx.params;
  const supabase = await createClient();

  const { data: atual } = await supabase
    .from("financial_entries")
    .select("id, status, origin, amount_cents, direction")
    .eq("id", id)
    .maybeSingle();
  if (!atual) return fail("not_found", "Lançamento não encontrado.", 404, { requestId });

  if (atual.status === "paid") {
    // Não é erro do usuário: ele clicou duas vezes. Devolver o mesmo desfecho é
    // melhor que um 409 que a tela teria de explicar.
    return ok({ id, status: "paid", ja_pago: true }, { requestId });
  }

  const { error } = await supabase
    .from("financial_entries")
    .update({ status: "paid", paid_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  await audit({
    action: "financeiro.lancamento_pago",
    resourceType: "financial_entry",
    resourceId: id,
    requestId,
    metadata: { amount_cents: atual.amount_cents, direction: atual.direction },
  });

  return ok({ id, status: "paid" }, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const { id } = await ctx.params;
  const supabase = await createClient();

  const { data: atual } = await supabase
    .from("financial_entries")
    .select("id, status, origin, amount_cents")
    .eq("id", id)
    .maybeSingle();
  if (!atual) return fail("not_found", "Lançamento não encontrado.", 404, { requestId });

  if (atual.status === "paid") {
    return fail(
      "conflict",
      "Lançamento pago não se apaga. Para desfazer, registre um lançamento contrário.",
      409,
      { requestId },
    );
  }
  if (atual.origin !== "manual") {
    return fail(
      "conflict",
      "Este lançamento veio de uma comanda. Para desfazer, estorne a comanda.",
      409,
      { requestId },
    );
  }

  const { error } = await supabase.from("financial_entries").delete().eq("id", id);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  await audit({
    action: "financeiro.lancamento_removido",
    resourceType: "financial_entry",
    resourceId: id,
    requestId,
    metadata: { amount_cents: atual.amount_cents },
  });

  return ok({ id, removed: true }, { requestId });
}
