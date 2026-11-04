import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { configEntregaSchema } from "@/lib/escalacao/entrega/passagem";
export const dynamic = "force-dynamic";
export async function GET() {
  const requestId = randomUUID();
  const a = await requireRole("manager", { requestId, resource: "handoff_delivery" });
  if (!a.ok) return a.response;
  const db = await createClient();
  const { data, error } = await db
    .from("organizations")
    .select("settings")
    .eq("id", a.org.orgId)
    .maybeSingle();
  if (error)
    return fail("internal_error", "Não foi possível ler a configuração", 500, { requestId });
  const raw = (data?.settings as Record<string, unknown> | null)?.handoff_delivery;
  const config = configEntregaSchema.safeParse(raw ?? {});
  const { getRequestPool } = await import("@/lib/agent-engine/db/request-pool");
  const { rows: issues } = await getRequestPool().query(
    "select conversation_id,status,reason,updated_at from handoff_delivery_episodes where organization_id=$1 and status in('pending','blocked','ambiguous') order by updated_at desc limit 20",
    [a.org.orgId],
  );
  return ok(
    { config: config.success ? config.data : configEntregaSchema.parse({}), issues },
    { requestId },
  );
}
export async function PATCH(req: NextRequest) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const a = await requireRole("manager", { requestId, resource: "handoff_delivery" });
  if (!a.ok) return a.response;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("validation_error", "Configuração inválida", 400, { requestId });
  }
  const parsed = configEntregaSchema.safeParse(raw);
  if (!parsed.success)
    return fail("validation_error", "Confira vendedores e números em formato internacional", 400, {
      requestId,
    });
  const db = await createClient();
  const { data, error } = await db.rpc("fn_set_handoff_delivery", {
    p_org: a.org.orgId,
    p_config: parsed.data,
  });
  if (error)
    return fail(
      "validation_error",
      "Confira os vendedores ativos da empresa e os destinos antes de salvar",
      400,
      { requestId },
    );
  void audit({
    action: "handoff.delivery_config_changed",
    actorUserId: a.user.id,
    organizationId: a.org.orgId,
    resourceType: "organization",
    resourceId: a.org.orgId,
    requestId,
    metadata: {
      enabled: parsed.data.enabled,
      sellers: parsed.data.seller_user_ids.length,
      supervisors: parsed.data.supervisor_destinations.length,
    },
  });
  return ok(data, { requestId });
}
