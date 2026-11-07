import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  return POST(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "avaliacao"))) {
    return ok({ atualizados: 0, modulo: "desligado" }, { requestId });
  }

  const { data: count, error } = await admin.rpc("fn_avaliacao_marcar_atrasados");
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const atualizados = typeof count === "number" ? count : 0;
  if (atualizados > 0) {
    void audit({
      action: "avaliacao.atrasados_atualizados",
      resourceType: "cron",
      resourceId: "avaliacao-atrasados",
      organizationId: null,
      actorUserId: null,
      metadata: { atualizados },
    });
  }

  return ok({ atualizados }, { requestId });
}
