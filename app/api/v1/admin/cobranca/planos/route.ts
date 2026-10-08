/**
 * POST /api/v1/admin/cobranca/planos — o dono da instalação cria um plano de
 * cobrança (spec da cobrança do revendedor §2.2, §7g).
 *
 * Plano é da INSTALAÇÃO (sem `organization_id`). Escrita de platform admin
 * (scope full + MFA); 404 com a chave `cobranca` desligada. Dois planos do
 * cadastro ao mesmo tempo → 409 `state_conflict` (índice
 * `cobranca_planos_um_padrao`). Sem `Idempotency-Key`: o recibo de
 * `lib/api/idempotency.ts` é por organização, e um clique duplo aqui gera um
 * plano a mais, que se arquiva.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { COLUNAS_DO_PLANO, novoPlanoSchema } from "@/lib/schemas/cobranca-plano";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(req: NextRequest) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();

  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "cobranca"))) return fail("not_found", "Not found", 404, { requestId });

  const corpo = novoPlanoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_failed", "Plano inválido", 400, { requestId, details: corpo.error.flatten() });
  }

  const { data: plano, error } = await admin
    .from("cobranca_planos")
    .insert({ ...corpo.data, updated_by: adminCtx.user.id })
    .select(COLUNAS_DO_PLANO)
    .single();
  if (error?.code === "23505") {
    return fail("state_conflict", "Já existe um plano do cadastro. Desmarque o outro antes.", 409, { requestId });
  }
  if (error || !plano) return fail("internal_error", "Não foi possível salvar o plano", 500, { requestId });

  void audit({
    action: "cobranca.plano_salvo",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    resourceType: "cobranca_plano",
    resourceId: plano.id,
    requestId,
    metadata: { criado: true, ...corpo.data },
  });
  return ok(plano, { status: 201, requestId });
}
