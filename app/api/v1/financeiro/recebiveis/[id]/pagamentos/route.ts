/**
 * POST /api/v1/financeiro/recebiveis/[id]/pagamentos — registrar recebimento.
 *
 * Teto garantido no serviço (`pagamento > saldo` vira 422, nunca pago a
 * maior). Idempotência via header `Idempotency-Key`: retry com a mesma chave
 * devolve o pagamento original (200 com `ja_existia: true`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { registrarPagamento } from "@/lib/comercial/financeiro";
import { pagamentoCreateSchema } from "@/lib/schemas/financeiro";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const ERRO_PT: Record<string, string> = {
  acima_do_saldo: "Valor maior que o saldo devedor.",
  valor_invalido: "Valor inválido.",
  recebivel_fechado: "Recebível já pago ou cancelado.",
  nao_achado: "Recebível não encontrado.",
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "financial_receivables" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  const parsed = pagamentoCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const chave = req.headers.get("Idempotency-Key")?.trim() || null;
  const admin = createAdminClient();
  let resultado: Awaited<ReturnType<typeof registrarPagamento>>;
  try {
    resultado = await registrarPagamento(admin, {
      orgId: authz.org.orgId,
      receivableId: id,
      valorCents: parsed.data.valor_cents,
      pagoEm: parsed.data.pago_em ?? null,
      forma: parsed.data.forma_pagamento ?? null,
      conta: parsed.data.conta ?? null,
      observacao: parsed.data.observacao ?? null,
      chave,
      criadoPor: authz.user.id,
      hojeIso: new Date().toISOString(),
    });
  } catch {
    return fail("internal_error", "Erro ao registrar o recebimento.", 500, { requestId });
  }
  if (!resultado.ok) {
    return fail("validation_failed", ERRO_PT[resultado.erro] ?? "Não foi possível registrar.", 422, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "financial_payment.created",
    resourceType: "financial_payments",
    resourceId: resultado.pagamentoId,
    requestId,
  });
  return ok(
    { id: resultado.pagamentoId, ja_existia: resultado.jaExistia, novo_status: resultado.novoStatus },
    { requestId, status: resultado.jaExistia ? 200 : 201 },
  );
}
