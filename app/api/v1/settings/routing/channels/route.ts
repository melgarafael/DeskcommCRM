import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { extractBearer } from "@/lib/mcp/auth";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { ok, fail } from "@/lib/api/wrappers";
import { channelRoutingPatchSchema } from "@/lib/schemas/routing";
import { loadChannelRoutingSettings } from "@/lib/routing/channel-policies";
import { audit } from "@/lib/audit";
export const dynamic = "force-dynamic";

/**
 * GET aceita sessão (como sempre) OU Bearer `dsk_…` (`config:read`, papel admin
 * via `tokenRole`). A sessão segue IDÊNTICA: `allowPlatformAdmin: "leitura"` e a
 * prova de MFA (`mfaEmDivida`). Só o ramo do token é novo, e a organização dele
 * vem da linha do token, nunca da query. O PATCH fica só de sessão
 * (`fn_set_channel_routing` exige `auth.uid()`).
 */
async function responder(
  obterDb: () => Promise<SupabaseClient>,
  organizationId: string,
  requestId: string,
): Promise<Response> {
  try {
    return ok(await loadChannelRoutingSettings(await obterDb(), organizationId), { requestId });
  } catch { return fail("internal_error", "Não foi possível carregar os responsáveis. Tente novamente.", 500, { requestId }); }
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (extractBearer(req.headers.get("authorization"))) {
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "settings_routing",
      role: "manager",
      scope: "config:read",
      tokenRole: "admin",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "settings.routing_channels", requestId);
    if (teto) return teto;
    return responder(async () => authz.supabase, authz.organizationId, requestId);
  }
  const auth = await requireRole("manager", { requestId, resource: "settings_routing", allowPlatformAdmin: "leitura" });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  return responder(() => createClient(), auth.org.orgId, requestId);
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
  // Regra POR NÚMERO (#2331): o modo e o destino padrão viajam na MESMA gravação
  // dos responsáveis — é uma tela, um botão. Omitir = gravar sem regra própria
  // (herda a organização), que é o que a tela antiga fazia.
  const distribution_mode = parsed.data.distribution_mode ?? null;
  const default_assignee_user_id = parsed.data.default_assignee_user_id ?? null;
  const { data, error } = await db.rpc("fn_set_channel_routing", {
    p_org: auth.org.orgId, p_channel: parsed.data.channel_session_id,
    p_users: parsed.data.user_ids, p_reset: parsed.data.reset,
    p_mode: distribution_mode, p_default_assignee: default_assignee_user_id,
  });
  if (error) {
    if (error.code === "P0002") return fail("not_found", "Canal não encontrado.", 404, { requestId });
    if (error.code === "22023") return fail("validation_failed", "A equipe mudou. Atualize a página e selecione novamente.", 422, { requestId });
    if (error.code === "42501") return fail("forbidden", "Esta sessão não pode alterar os responsáveis.", 403, { requestId });
    return fail("internal_error", "Não foi possível salvar. Tente novamente.", 500, { requestId });
  }
  void audit({ action: "routing.config_changed", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "channel_session", resourceId: parsed.data.channel_session_id, requestId,
    metadata: { user_ids: parsed.data.user_ids, reset: parsed.data.reset,
      distribution_mode, default_assignee_user_id } });
  return ok(data, { requestId });
}
