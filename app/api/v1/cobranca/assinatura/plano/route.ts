/**
 * POST /api/v1/cobranca/assinatura/plano — a empresa troca de plano (spec §7e):
 * o MESMO caminho do card do dono (`lib/cobranca/troca.ts`). Em teste grátis
 * vale na hora; depois, na próxima cobrança paga — e a tela diz a data.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { limiteDoProvedorPorOrg } from "@/lib/cobranca/falhas";
import { trocarPlanoDaOrg } from "@/lib/cobranca/troca";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const corpoSchema = z.strictObject({ plano_id: z.string().uuid() });

export async function POST(req: NextRequest) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "cobranca_assinaturas", permiteOrgSuspensa: true });
  if (!authz.ok) return authz.response;
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "cobranca"))) return fail("not_found", "Not found", 404, { requestId });
  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) return fail("validation_failed", "Escolha um plano.", 400, { requestId, details: corpo.error.flatten() });

  const orgId = authz.org.orgId;
  if (!(await limiteDoProvedorPorOrg(orgId))) {
    return fail("rate_limited", "Muitas tentativas seguidas. Aguarde um minuto e tente de novo.", 429, { requestId, headers: { "Retry-After": "60" } });
  }
  const r = await trocarPlanoDaOrg(admin, orgId, corpo.data.plano_id);
  if (!r.ok) return fail(r.code, r.message, r.status, { requestId, ...(r.details === undefined ? {} : { details: r.details }) });
  if (r.changed) {
    void audit({
      action: "cobranca.plano_trocado",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "cobranca_assinatura",
      resourceId: orgId,
      requestId,
      metadata: { de: r.de, para: corpo.data.plano_id, quando: r.quando },
    });
  }
  return ok(
    { changed: r.changed, quando: r.quando, plano_id: r.planoId, plano_agendado_id: r.planoAgendadoId, vale_a_partir_de: r.valeAPartirDe },
    { requestId },
  );
}
