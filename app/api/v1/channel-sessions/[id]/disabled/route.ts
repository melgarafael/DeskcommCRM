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
import { canalDesativado } from "@/lib/channels/desativado";
import { sincronizarAvisoDePausa } from "@/lib/channels/central-de-pausa";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

const toggleSchema = z.object({ disabled: z.boolean() }).strict();

/** Lê se o canal está desativado pelo operador. */
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
    return lerDisabled(authz.supabase, authz.organizationId, (await params).id, requestId);
  }

  const auth = await requireRole("admin", { requestId, resource: "channel_sessions", allowPlatformAdmin: "leitura" });
  if (!auth.ok) return auth.response;
  return lerDisabled(createAdminClient(), auth.org.orgId, (await params).id, requestId);
}

async function lerDisabled(
  db: SupabaseClient,
  organizationId: string,
  id: string,
  requestId: string,
): Promise<Response> {
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "Canal inválido.", 422, { requestId });
  const { data, error } = await db.from("channel_sessions")
    .select("metadata").eq("organization_id", organizationId).eq("id", id)
    .is("archived_at", null).maybeSingle();
  if (error) return fail("internal_error", "Não foi possível carregar o estado do canal.", 500, { requestId });
  if (!data) return fail("not_found", "Canal não encontrado.", 404, { requestId });
  return ok({ disabled: canalDesativado(data.metadata) }, { requestId });
}

/** Só administradores ligam/desligam um canal. Arquivado não se pausa: se exclui. */
export async function PATCH(req: NextRequest, { params }: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "channel_sessions", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "Canal inválido.", 422, { requestId });
  const parsed = toggleSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Informe disabled como verdadeiro ou falso.", 422, { requestId });
  // RPC atômica: troca só a chave `disabled` sem sobrescrever o resto do metadata.
  const { data, error } = await createAdminClient().rpc("fn_definir_canal_desativado", {
    p_org: auth.org.orgId, p_canal: id, p_desativado: parsed.data.disabled,
  });
  if (error) return fail("internal_error", "Não foi possível salvar o estado do canal. Verifique se o banco está atualizado.", 500, { requestId });
  if (data !== 1) return fail("not_found", "Canal não encontrado.", 404, { requestId });
  void audit({
    action: parsed.data.disabled ? "channel.disabled" : "channel.enabled", actorUserId: auth.user.id,
    organizationId: auth.org.orgId, resourceType: "channel_session", resourceId: id, requestId,
    metadata: { disabled: parsed.data.disabled },
  });
  // O aviso da Central nasce e morre na MESMA rodada do clique (issue #2389):
  // pausar abre um item com o canal, o autor e o horário; retomar resolve o
  // MESMO item com o motivo no corpo, sem ninguém clicar. Best-effort e nunca
  // lançante — a pausa já foi gravada pela RPC acima.
  await sincronizarAvisoDePausa(
    createAdminClient(),
    { id, organization_id: auth.org.orgId },
    { autor: (auth.user.full_name ?? "").trim() || auth.user.email || auth.user.id, idioma: auth.user.idioma },
  );
  return ok(parsed.data, { requestId });
}
