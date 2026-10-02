import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/admin/tenants/[id]/suspend (S-11.08)
 *
 * Suspensão ADMINISTRATIVA pela função definer `fn_suspender_organizacao`, numa
 * transação só: status + tipo, jobs `pending` → `failed`, mensagens `queued` →
 * `failed` e `event_log tenant.suspended`. Antes era leitura, UPDATE e um
 * `event_log` solto sem await — não atômico.
 *
 * Body `{reason}` (10–500). O tipo NÃO vem do body: pela sessão é sempre
 * 'administrativa'. Exige `requirePlatformAdminEscrita()` (scope full + MFA).
 * Resposta: o jsonb da função, `{changed, motivo?}`.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import type { TipoDeSuspensao } from "@/lib/organizacao/operante";
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
const KIND: TipoDeSuspensao = "administrativa";

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
  // Só para o 404 e o slug do audit; a decisão e a escrita são da função.
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("id, slug")
    .eq("id", tenantId)
    .maybeSingle();
  if (orgError || !org) {
    return fail("not_found", "Tenant not found", 404, { requestId });
  }

  const { data, error } = await admin.rpc("fn_suspender_organizacao", {
    p_org: tenantId,
    p_kind: KIND,
    p_motivo: body.reason,
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
    return fail("internal_error", "Failed to suspend tenant", 500, { requestId });
  }

  if (resultado.data.changed) {
    void audit({
      action: "tenant.suspended",
      actorUserId: adminCtx.user.id,
      actingAsPlatformAdmin: true,
      bypassedRls: true,
      organizationId: tenantId,
      resourceType: "organization",
      resourceId: tenantId,
      requestId,
      metadata: { tenant_id: tenantId, tenant_slug: org.slug, suspended_by: adminCtx.user.id, reason: body.reason, kind: KIND },
    });
  }

  return ok(resultado.data, { requestId });
}
