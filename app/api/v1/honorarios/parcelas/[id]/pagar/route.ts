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
 * `fn_honorarios_parcela_pagar` (migration 0480) faz os três passos numa função com
 * `for update`, o mesmo desenho de `fn_finalizar_comanda`.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Tag do endpoint no recibo de idempotência. */
const ENDPOINT = "/api/v1/honorarios/parcelas/[id]/pagar";

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

  // Idempotency-Key, quando vem, tem de ser UUID — a mesma régua de `message-templates`.
  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID", 400, { requestId });
  }

  const supabase = await createClient();
  // Estreitados aqui: dentro de `pagar()` o TypeScript não carrega o `if` de cima.
  const orgId = authz.org.orgId;
  const atorId = authz.user.id;
  const corpo = lido.data;

  /**
   * O efeito. Lança `Recusa` quando a função recusa: o helper de idempotência
   * propaga sem gravar recibo, e a retentativa com a mesma chave executa de novo
   * em vez de receber o replay de um pagamento que não aconteceu.
   */
  async function pagar(): Promise<ParcelaPaga> {
    const { data, error } = await supabase.rpc("fn_honorarios_parcela_pagar", {
      p_org: orgId,
      p_parcela: parcelaId,
      p_account_id: corpo.account_id,
      p_account_plan_id: corpo.account_plan_id ?? null,
    });
    if (error) throw new Recusa(respostaDaRecusa(error, requestId));

    const parcelaPaga = data as ParcelaPaga;
    await audit({
      action: "honorarios.parcela_paga",
      actorUserId: atorId,
      organizationId: orgId,
      resourceType: "honorarios_parcela",
      resourceId: parcelaId,
      requestId,
      metadata: {
        contrato_id: parcelaPaga.contrato_id,
        financial_entry_id: parcelaPaga.financial_entry_id,
      },
    });
    return parcelaPaga;
  }

  try {
    if (chave === null) return ok(await pagar(), { requestId });

    // Com a chave, um retry do MESMO pedido (rede que caiu depois do pagamento)
    // devolve o recibo gravado em vez de "já paga". O corpo do hash leva a
    // parcela: a mesma chave numa parcela diferente é conflito, não replay.
    const desfecho = await comIdempotencia({
      db: supabase,
      organizationId: orgId,
      endpoint: ENDPOINT,
      chave,
      corpo: { parcela_id: parcelaId, ...corpo },
      executar: async () => ({ resposta: await pagar(), status: 200 }),
    });
    if (desfecho.tipo === "conflito") {
      return fail(
        "idempotency_conflict",
        "Esta chave de idempotência já foi usada com outro conteúdo.",
        409,
        { requestId },
      );
    }
    if (desfecho.tipo === "em_curso") {
      return fail(
        "idempotency_in_progress",
        "O mesmo pagamento ainda está em curso. Tente de novo em instantes.",
        409,
        { requestId },
      );
    }
    return ok(desfecho.resposta, { requestId });
  } catch (erro) {
    if (erro instanceof Recusa) return erro.resposta;
    return fail("internal_error", "Erro ao registrar o pagamento.", 500, { requestId });
  }
}

type ParcelaPaga = {
  id: string;
  contrato_id: string;
  numero: number;
  valor_cents: number;
  status: string;
  financial_entry_id: string;
};

/** A recusa da função, já como a resposta HTTP que ela vira. */
class Recusa extends Error {
  constructor(readonly resposta: Response) {
    super("recusa");
  }
}

function respostaDaRecusa(error: { message?: string; code?: string }, requestId: string): Response {
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
  if (error.message === "conta_invalida" || error.code === "23503") {
    return fail("validation_failed", "Conta ou plano de contas inválido.", 422, { requestId });
  }
  return fail("internal_error", "Erro ao registrar o pagamento.", 500, { requestId });
}
