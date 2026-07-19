/**
 * GET  /api/v1/settings/routing — lê organizations.settings.routing (manager+).
 * PATCH /api/v1/settings/routing — grava a config de roteamento (manager+).
 *
 * Rota v1 dedicada (não o Server Action updateTenant): a matriz spec 13 §4 nota
 * 5 separa autz — routing/atendimento é manager+, enquanto o perfil da org
 * (updateTenant) é admin-only. Forçar routing no updateTenant misturaria os dois
 * gates. Merge não-destrutivo do jsonb settings (preserva as demais chaves).
 *
 * knobs (max_retries, backoff_seconds) são CONFIG — o worker de G5-02 LÊ daqui;
 * nunca constantes hardcoded no worker (doutrina). org de fonte confiável.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { routingConfigSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Default aplicado quando settings.routing ainda não existe (G1-06b). */
const DEFAULT_ROUTING = routingConfigSchema.parse({});

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_routing" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: orgRow, error } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const settings = (orgRow?.settings as Record<string, unknown> | null) ?? {};
  const routing = routingConfigSchema.catch(DEFAULT_ROUTING).parse(settings.routing ?? {});
  return ok(routing, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_routing" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let input;
  try {
    input = await validateRequest(routingConfigSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const supabase = await createClient();
  const { data: orgRow, error: readErr } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  if (readErr) return fail("internal_error", readErr.message, 500, { requestId });

  const currentSettings = (orgRow?.settings as Record<string, unknown> | null) ?? {};
  const nextSettings = { ...currentSettings, routing: input };

  const { error: updErr } = await supabase
    .from("organizations")
    .update({ settings: nextSettings })
    .eq("id", activeOrg.orgId);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  void audit({
    action: "routing.config_changed",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId,
    metadata: { routing: input },
  });

  return ok(input, { requestId });
}
