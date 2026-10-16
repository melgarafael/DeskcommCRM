import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { sincronizarComMeta } from "@/lib/social-insights/meta-client";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "social_insights" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const orgId = authz.org.orgId;

  const res = await sincronizarComMeta(admin, orgId);
  if (!res.sucesso) {
    return fail("upstream_error", res.mensagem ?? "Erro ao sincronizar com a Meta", 400, {
      requestId,
    });
  }

  return ok({ sincronizado: true, timestamp: new Date().toISOString() }, { requestId });
}
