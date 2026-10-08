/**
 * POST /api/v1/admin/tenants/[id]/assinatura/prazo — "Dar prazo até DD/MM"
 * (spec da cobrança do revendedor §7g, D-6).
 *
 * Grava `prazo_extra_ate` (a régua não suspende antes dele) e, se a empresa está
 * suspensa por cobrança, reativa na hora. O máximo é 60 dias; data passada ou
 * além disso → 422. Empresa sem assinatura é isenta: não há o que prorrogar → 404.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { lerOrgDoTenant, reativarSeSuspensaPorCobranca } from "@/lib/cobranca/dono";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

const corpoSchema = z.strictObject({ ate: z.string().datetime({ offset: true }) });
const PRAZO_MAXIMO_MS = 60 * 86_400_000;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: tenantId } = await params;
  const supportDenied = await requireSupportWrite(tenantId);
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();

  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "cobranca")) || !z.string().uuid().safeParse(tenantId).success) {
    return fail("not_found", "Not found", 404, { requestId });
  }

  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_failed", "Informe a data do prazo", 400, { requestId, details: corpo.error.flatten() });
  }
  const agora = Date.now();
  const ate = new Date(corpo.data.ate);
  if (ate.getTime() <= agora || ate.getTime() > agora + PRAZO_MAXIMO_MS) {
    return fail("validation_failed", "O prazo precisa estar entre agora e 60 dias.", 422, { requestId });
  }

  const org = await lerOrgDoTenant(admin, tenantId);
  if (org === "erro") return fail("internal_error", "Não foi possível ler a empresa", 500, { requestId });
  if (!org) return fail("not_found", "Tenant not found", 404, { requestId });

  const { data: linha, error } = await admin
    .from("cobranca_assinaturas")
    .update({ prazo_extra_ate: ate.toISOString(), updated_at: new Date(agora).toISOString() })
    .eq("organization_id", tenantId)
    .select("organization_id")
    .maybeSingle();
  if (error) return fail("internal_error", "Não foi possível gravar o prazo", 500, { requestId });
  if (!linha) {
    return fail("not_found", "Esta empresa não tem assinatura (é isenta): não há o que prorrogar.", 404, { requestId });
  }

  const reativacao = await reativarSeSuspensaPorCobranca(admin, org, adminCtx.user.id);
  // O prazo já foi gravado: a mutação audita mesmo quando a reativação falha.
  void audit({
    action: "cobranca.prazo_concedido",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: tenantId,
    resourceType: "cobranca_assinatura",
    resourceId: tenantId,
    requestId,
    metadata: { ate: ate.toISOString(), reativada: reativacao?.reativada ?? false },
  });
  if (!reativacao) {
    return fail("internal_error", "O prazo foi gravado, mas a reativação falhou. Tente de novo.", 500, { requestId });
  }
  return ok({ prazo_extra_ate: ate.toISOString(), reativada: reativacao.reativada }, { requestId });
}
