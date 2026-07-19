/**
 * GET /api/v1/pipelines — lista os funis da org ativa (nome + slug), RLS-scoped.
 * Existia só o handler interno (usado pelo MCP); expõe REST pro Select de
 * pipeline do CreateSourceDialog (feature Webhooks).
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { listPipelinesHandler } from "./_handler";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "pipelines" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  try {
    const { pipelines } = await listPipelinesHandler(supabase, {
      organization_id: authz.org.orgId,
      actor: { type: "user", id: authz.user.id },
      requestId,
    });
    return ok(pipelines, { requestId });
  } catch {
    return fail("internal_error", "Falha ao listar funis.", 500, { requestId });
  }
}
