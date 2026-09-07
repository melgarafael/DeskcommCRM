import { randomUUID } from "node:crypto";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { ok, fail } from "@/lib/api/wrappers";
import { channelRoutingPatchSchema } from "@/lib/schemas/routing";
import { loadChannelRoutingSettings } from "@/lib/routing/channel-policies";
import { audit } from "@/lib/audit";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "settings_routing", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  try {
    return ok(await loadChannelRoutingSettings(await createClient(), auth.org.orgId), { requestId });
  } catch { return fail("internal_error", "Não foi possível carregar os responsáveis. Tente novamente.", 500, { requestId }); }
}

export async function PATCH(req: Request): Promise<Response> {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "settings_routing", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  const parsed = channelRoutingPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Confira o canal e os responsáveis selecionados.", 422, { requestId });
  const db = await createClient();
  const { data, error } = await db.rpc("fn_set_channel_routing", {
    p_org: auth.org.orgId, p_channel: parsed.data.channel_session_id,
    p_users: parsed.data.user_ids, p_reset: parsed.data.reset,
  });
  if (error) {
    if (error.code === "P0002") return fail("not_found", "Canal não encontrado.", 404, { requestId });
    if (error.code === "22023") return fail("validation_failed", "A equipe mudou. Atualize a página e selecione novamente.", 422, { requestId });
    if (error.code === "42501") return fail("forbidden", "Esta sessão não pode alterar os responsáveis.", 403, { requestId });
    return fail("internal_error", "Não foi possível salvar. Tente novamente.", 500, { requestId });
  }
  void audit({ action: "routing.config_changed", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "channel_session", resourceId: parsed.data.channel_session_id, requestId,
    metadata: { user_ids: parsed.data.user_ids, reset: parsed.data.reset } });
  return ok(data, { requestId });
}
