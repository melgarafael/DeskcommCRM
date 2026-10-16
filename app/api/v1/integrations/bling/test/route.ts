import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { obterClienteBlingAutenticado, registrarLogBling } from "@/lib/integrations/bling/store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "bling_integration" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const orgId = authz.org.orgId;

  const { client, error } = await obterClienteBlingAutenticado(admin, orgId);
  if (error || !client) {
    return fail("validation_failed", error || "Cliente Bling não pôde ser inicializado", 400, {
      requestId,
    });
  }

  const resultado = await client.testarConexao();

  await registrarLogBling(admin, orgId, {
    operation: "test_connection",
    direction: "outbound",
    status: resultado.ok ? "success" : "failed",
    details: { message: resultado.message },
    error_message: resultado.ok ? null : resultado.message,
  });

  if (!resultado.ok) {
    return fail("integration_error", resultado.message, 400, { requestId });
  }

  return ok({ success: true, message: resultado.message }, { requestId });
}
