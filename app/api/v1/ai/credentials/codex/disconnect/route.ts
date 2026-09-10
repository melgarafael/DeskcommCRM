import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/credentials/codex/disconnect — desliga o vínculo (admin).
 * Marca `revoked`; o refresh deixa de ser lido pelo resolver. Não apaga a
 * linha (auditoria de quem conectou o quê fica preservada).
 */
import { randomUUID } from "node:crypto";

import { audit } from "@/lib/audit";
import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { revogarVinculo } from "@/lib/ai/codex/armazenamento";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_credentials" });
  if (!authz.ok) return authz.response;

  await revogarVinculo(createAdminClient(), authz.org.orgId);
  await audit({
    action: "ai.codex.desconexao",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "ai_provider_oauth",
    requestId,
  });
  return ok({ ok: true }, { requestId });
}
