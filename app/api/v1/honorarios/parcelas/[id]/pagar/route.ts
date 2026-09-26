/**
 * Marcar uma parcela de honorários como PAGA.
 *
 * DIRC "integrar", não "duplicar": não existe uma tabela de "pagamento" própria do módulo. Pagar
 * cria um `financial_entries` (direction='in', origin='manual' — o CHECK de `financial_entries`
 * não tem valor `'honorarios'`, e adicioná-lo mudaria o caixa NÚCLEO por causa de uma extensão)
 * e liga por `financial_entry_id`; o extrato do caixa já enxerga o dinheiro sem saber de onde veio.
 *
 * ⚠️ ATÔMICO POR RPC (achado da revisão do PR #1578), não três chamadas separadas do
 * PostgREST: ler status, inserir o lançamento e atualizar a parcela em requests distintos
 * deixava uma janela onde dois cliques (ou um retry) na mesma parcela liam "pendente" nos
 * dois e cada um lançava o SEU financial_entries — pagamento em dobro no caixa.
 * `fn_honorarios_parcela_pagar` (migration 0398) faz os três passos numa função com
 * `for update`, o mesmo desenho de `fn_finalizar_comanda`.
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

  const { data, error } = await supabase.rpc("fn_honorarios_parcela_pagar", {
    p_org: authz.org.orgId,
    p_parcela: parcelaId,
    p_account_id: lido.data.account_id,
    p_account_plan_id: lido.data.account_plan_id ?? null,
  });

  if (error) {
    if (moduloNaoInstalado(error)) {
      return fail("module_not_installed", MODULO_NAO_INSTALADO, 409, { requestId });
    }
    if (error.message === "honorarios_forbidden") {
      return fail("forbidden_role", "Papel insuficiente.", 403, { requestId });
    }
    if (error.message === "parcela_nao_encontrada") {
      return fail("not_found", "Parcela não encontrada.", 404, { requestId });
    }
    if (error.message === "parcela_ja_paga") {
      return fail("validation_failed", "Esta parcela já está paga.", 422, { requestId });
    }
    if (error.code === "23503") {
      return fail("validation_failed", "Conta ou plano de contas inválido.", 422, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  const parcelaPaga = data as {
    id: string;
    contrato_id: string;
    numero: number;
    valor_cents: number;
    status: string;
    financial_entry_id: string;
  };

  await audit({
    action: "honorarios.parcela_paga",
    resourceType: "honorarios_parcela",
    resourceId: parcelaId,
    requestId,
    metadata: {
      contrato_id: parcelaPaga.contrato_id,
      financial_entry_id: parcelaPaga.financial_entry_id,
    },
  });

  return ok(parcelaPaga, { requestId });
}
