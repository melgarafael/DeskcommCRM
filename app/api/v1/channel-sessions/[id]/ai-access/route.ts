import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractBearer } from "@/lib/mcp/auth";
import {
  aiAccessUpdateSchema, lerModoDeAcessoDaIa, lerNumerosDeTeste,
} from "@/lib/ai/elegibilidade/pre-go-live";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/** Só administradores podem ler os telefones de teste ou mudar o alcance da IA. */
export async function GET(req: NextRequest, { params }: Context): Promise<Response> {
  const requestId = randomUUID();

  // DOIS PORTÕES, UM CORPO (Spec 33, R3). O token `dsk_…` (escopo `mcp:read`,
  // papel admin) entra por `resolveAuthDual`; a sessão segue pelo `requireRole`
  // de sempre. A organização vem da linha do token ou da sessão, nunca do path.
  if (extractBearer(req.headers.get("authorization"))) {
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "channel_sessions",
      role: "admin",
      scope: "mcp:read",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "channel_sessions", requestId);
    if (teto) return teto;
    return lerAiAccess(authz.supabase, authz.organizationId, (await params).id, requestId);
  }

  const auth = await requireRole("admin", { requestId, resource: "channel_sessions", allowPlatformAdmin: "leitura" });
  if (!auth.ok) return auth.response;
  return lerAiAccess(createAdminClient(), auth.org.orgId, (await params).id, requestId);
}

async function lerAiAccess(
  db: SupabaseClient,
  organizationId: string,
  id: string,
  requestId: string,
): Promise<Response> {
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "Canal inválido.", 422, { requestId });
  const { data, error } = await db.from("channel_sessions")
    .select("metadata").eq("organization_id", organizationId).eq("id", id)
    .is("archived_at", null).maybeSingle();
  if (error) return fail("internal_error", "Não foi possível carregar o acesso da IA.", 500, { requestId });
  if (!data) return fail("not_found", "Canal não encontrado.", 404, { requestId });
  return ok({ mode: lerModoDeAcessoDaIa(data.metadata), test_phone_numbers: lerNumerosDeTeste(data.metadata) }, { requestId });
}

export async function PATCH(req: NextRequest, { params }: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "channel_sessions", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "Canal inválido.", 422, { requestId });
  const parsed = aiAccessUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Use telefones com DDI, por exemplo +5511999998888.", 422, { requestId });
  const { mode, test_phone_numbers } = parsed.data;
  // RPC atômica: não sobrescreve as demais configurações de metadata.
  const { data, error } = await createAdminClient().rpc("fn_configurar_pre_go_live_canal", {
    p_org: auth.org.orgId, p_canal: id, p_modo: mode, p_numeros: test_phone_numbers,
  });
  if (error) return fail("internal_error", "Não foi possível salvar o acesso da IA. Verifique se o banco está atualizado.", 500, { requestId });
  if (data !== 1) return fail("not_found", "Canal não encontrado.", 404, { requestId });
  void audit({
    action: "channel.ai_access_updated", actorUserId: auth.user.id,
    organizationId: auth.org.orgId, resourceType: "channel_session", resourceId: id, requestId,
    metadata: { mode, test_phone_numbers_count: test_phone_numbers.length },
  });
  return ok(parsed.data, { requestId });
}
