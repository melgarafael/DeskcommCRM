/**
 * Marcar uma parcela de honorários como PAGA.
 *
 * DIRC "integrar", não "duplicar": não existe uma tabela de "pagamento" própria do módulo. Pagar
 * cria um `financial_entries` (direction='in', origin='manual' — o CHECK de `financial_entries`
 * não tem valor `'honorarios'`, e adicioná-lo mudaria o caixa NÚCLEO por causa de uma extensão)
 * e liga por `financial_entry_id`; o extrato do caixa já enxerga o dinheiro sem saber de onde veio.
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

const MODULO_NAO_INSTALADO =
  "O módulo de honorários não está instalado nesta instalação. Peça ao administrador para " +
  "instalar em Configurações da instalação › Módulos.";

function moduloNaoInstalado(error: { code?: string } | null): boolean {
  return error?.code === "42P01";
}

const bodySchema = z.object({
  account_id: z.string().uuid(),
  account_plan_id: z.string().uuid().nullish(),
});

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("manager", { requestId, resource: "honorarios_parcelas" });
  if (!authz.ok) return authz.response;
  const { id: parcelaId } = await ctx.params;

  const lido = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, {
      requestId,
    });
  }

  const supabase = await createClient();

  const { data: parcela, error: erroLeitura } = await supabase
    .from("honorarios_parcelas")
    .select("id, contrato_id, numero, valor_cents, status, financial_entry_id")
    .eq("id", parcelaId)
    .maybeSingle();

  if (erroLeitura) {
    if (moduloNaoInstalado(erroLeitura)) {
      return fail("module_not_installed", MODULO_NAO_INSTALADO, 409, { requestId });
    }
    return fail("internal_error", erroLeitura.message, 500, { requestId });
  }
  if (!parcela) {
    return fail("not_found", "Parcela não encontrada.", 404, { requestId });
  }
  if (parcela.status === "pago") {
    return fail("validation_failed", "Esta parcela já está paga.", 422, { requestId });
  }

  const { data: lancamento, error: erroLancamento } = await supabase
    .from("financial_entries")
    .insert({
      organization_id: authz.org.orgId,
      account_id: lido.data.account_id,
      account_plan_id: lido.data.account_plan_id ?? null,
      direction: "in",
      amount_cents: parcela.valor_cents,
      description: `Parcela ${parcela.numero} de honorários`,
      status: "paid",
      paid_at: new Date().toISOString(),
      origin: "manual",
      created_by_user_id: authz.user.id,
    })
    .select("id")
    .single();

  if (erroLancamento) {
    if (erroLancamento.code === "23503") {
      return fail("validation_failed", "Conta ou plano de contas inválido.", 422, { requestId });
    }
    return fail("internal_error", erroLancamento.message, 500, { requestId });
  }

  const { data: parcelaPaga, error: erroAtualizacao } = await supabase
    .from("honorarios_parcelas")
    .update({ status: "pago", financial_entry_id: lancamento.id })
    .eq("id", parcelaId)
    .select("id, contrato_id, numero, valor_cents, status, financial_entry_id")
    .single();

  if (erroAtualizacao) {
    return fail("internal_error", erroAtualizacao.message, 500, { requestId });
  }

  await audit({
    action: "honorarios.parcela_paga",
    resourceType: "honorarios_parcela",
    resourceId: parcelaId,
    requestId,
    metadata: { contrato_id: parcela.contrato_id, financial_entry_id: lancamento.id },
  });

  return ok(parcelaPaga, { requestId });
}
