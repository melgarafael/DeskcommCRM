import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/admin/tenants/[id]/reactivate (S-11.08)
 *
 * Reativa a suspensão ADMINISTRATIVA pela função definer `fn_reativar_organizacao`
 * (status, cinto da fila, item `org_reativada` na Central, `event_log`, numa
 * transação). Suspensão por COBRANÇA não sai por aqui: 409
 * `suspensao_de_cobranca` — a saída é "Dar prazo" ou "Tornar isenta" (D-6).
 * `reason` (10–500) vai só para o audit. Resposta: `{changed, motivo?}`.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { type TipoDeSuspensao } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";

const bodySchema = z.object({
  reason: z
    .string()
    .min(10, "Motivo deve ter ao menos 10 caracteres")
    .max(500, "Motivo deve ter no máximo 500 caracteres"),
});
const resultadoSchema = z.object({ changed: z.boolean(), motivo: z.string().optional() });
const MENSAGEM_DE_RETENTAR = "Outra operação está em andamento para esta empresa. Tente de novo em instantes.";
const KIND_EXIGIDO: TipoDeSuspensao = "administrativa";
const KIND_DE_COBRANCA: TipoDeSuspensao = "cobranca";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supportDenied = await requireSupportWrite((await params).id);
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: tenantId } = await params;

  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return fail("validation_failed", "Invalid request body", 400, { requestId });
  }

  const admin = createAdminClient();
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("id, slug, status, suspended_kind")
    .eq("id", tenantId)
    .maybeSingle();
  if (orgError || !org) {
    return fail("not_found", "Tenant not found", 404, { requestId });
  }

  // `suspended_kind` só significa algo com status='suspended' (operante.ts): a
  // org redigida é parada e guarda o tipo residual, e não se negocia pagamento
  // com ela. A função também recusa o kind divergente; aqui é para a mensagem ter nome.
  if (org.status === "suspended" && org.suspended_kind === KIND_DE_COBRANCA) {
    return fail(
      "suspensao_de_cobranca",
      "Esta suspensão é por falta de pagamento. Use Dar prazo ou Tornar isenta.",
      409,
      { requestId },
    );
  }

  const { data, error } = await admin.rpc("fn_reativar_organizacao", {
    p_org: tenantId,
    p_kind_exigido: KIND_EXIGIDO,
    p_ator: adminCtx.user.id,
  });
  // 40001 = `appointment_notice_busy`: o descarte da fila avisa o Meet com
  // trava SEM espera (esperar ali, com a linha da org em `for update`, arrisca
  // deadlock). A transação inteira voltou; quem tenta de novo passa.
  if (error?.code === "40001") {
    return fail("retry_later", MENSAGEM_DE_RETENTAR, 409, { requestId });
  }
  const resultado = resultadoSchema.safeParse(data);
  if (error || !resultado.success) {
    return fail("internal_error", "Failed to reactivate tenant", 500, { requestId });
  }

  if (resultado.data.changed) {
    void audit({
      action: "tenant.reactivated",
      actorUserId: adminCtx.user.id,
      actingAsPlatformAdmin: true,
      bypassedRls: true,
      organizationId: tenantId,
      resourceType: "organization",
      resourceId: tenantId,
      requestId,
      metadata: { tenant_id: tenantId, tenant_slug: org.slug, reactivated_by: adminCtx.user.id, reason: body.reason },
    });
  }

  return ok(resultado.data, { requestId });
}
