/** Instalar é decisão do servidor; usar é decisão explícita de cada empresa. */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
export const dynamic = "force-dynamic";
const schema = z.object({ enabled: z.boolean() }).strict();
export async function PATCH(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "cadencias" });
  if (!authz.ok) return authz.response;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Dados inválidos.", 422, { requestId });
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "cadencias"))) return fail("not_found", "Módulo indisponível.", 404, { requestId });
  const { data, error } = await admin.rpc("fn_cadencias_configurar", { p_organization_id: authz.org.orgId, p_enabled: parsed.data.enabled });
  if (error || data !== true) return fail("internal_error", "Não foi possível salvar a configuração.", 500, { requestId });
  void audit({ action: "cadencia.settings_updated", actorUserId: authz.user.id, organizationId: authz.org.orgId, resourceType: "organization", resourceId: authz.org.orgId, requestId, metadata: { enabled: parsed.data.enabled } });
  return ok(parsed.data, { requestId });
}
