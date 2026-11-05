import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followup-flows/:id/disable — status='disabled' (manager+).
 * No-op ok (200, sem novo audit) se já estava disabled.
 *
 * Sessão OU token de integração (Spec 33, R1): o token precisa de
 * `config:write` e papel admin (`tokenRole`). A organização sai de
 * `authz.organizationId` (linha do token, nunca do caminho), e no ramo do
 * token o cliente é a service role: o `organization_id` de cada consulta
 * abaixo é a única barreira.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "followup_flows",
    role: "manager",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "followup_flows", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const { organizationId } = authz;
  const actorUserId = authz.actor.type === "user" ? authz.actor.id : null;

  const supabase = authz.supabase;
  const { data: existing, error: fetchErr } = await supabase
    .from("followup_flow_pointers")
    .select("id, status")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", t("Fluxo não encontrado."), 404, { requestId });

  if (existing.status === "disabled") {
    return ok({ id, status: "disabled" }, { requestId });
  }

  const { data: updated, error: updErr } = await supabase
    .from("followup_flow_pointers")
    .update({ status: "disabled", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id, status, updated_at")
    .single();
  if (updErr || !updated) {
    return fail("internal_error", updErr?.message ?? "followup_flow_disable_failed", 500, {
      requestId,
    });
  }

  void audit({
    action: "followup_flow.disabled",
    actorUserId,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId,
    resourceType: "followup_flow_pointer",
    resourceId: id,
    requestId,
  });

  return ok(updated, { requestId });
}
