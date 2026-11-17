import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST   /api/v1/conversations/[id]/snooze — define lembrete ("avise se o lead não responder em X h").
 * DELETE /api/v1/conversations/[id]/snooze — cancela o lembrete ativo.
 *
 * Reabertura + aviso interno no vencimento é responsabilidade do cron
 * `snooze-watcher` — nada é enviado ao cliente aqui.
 *
 * `.eq("organization_id", org.orgId)` é defesa extra; a RLS
 * `conversations_tenant_isolation_all` já cobre o UPDATE por membro da org.
 * `.select("id").maybeSingle()` confirma que a linha existia e era escrevível —
 * sem isso, um UPDATE barrado pela RLS afeta 0 linhas mas ainda retornaria
 * sucesso + audit falso (mutação que não ocorreu). Mesma lição do DELETE de
 * message-templates.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok, noContent } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { requireRole } from "@/lib/auth/require-role";
import { snoozeSchema } from "@/lib/schemas/snooze";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await params;

  const authHeader = req.headers.get("authorization");
  if (authHeader && /^Bearer\s+/i.test(authHeader.trim())) {
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "conversations",
      role: "agent",
      scope: "mcp:write",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "conversations", requestId);
    if (teto) return teto;
    const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
    const { organizationId } = authz;
    const supabase = authz.supabase;
    const actorId = authz.actor.type === "user" ? authz.actor.id : null;
    return responderSnoozePost(supabase, organizationId, id, req, requestId, t, actorId, authz.apiTokenId ?? null);
  }

  // Caminho de sessão: byte a byte igual.
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const supabase = await createClient();
  return responderSnoozePost(supabase, org.orgId, id, req, requestId, t, user.id, null);
}

async function responderSnoozePost(
  supabase: SupabaseClient,
  organizationId: string,
  conversationId: string,
  req: NextRequest,
  requestId: string,
  t: (texto: string) => string,
  actorUserId: string | null,
  actorApiTokenId: string | null,
): Promise<Response> {
  const raw = await req.json().catch(() => null);
  const parsed = snoozeSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { duration_hours } = parsed.data;

  const nowIso = new Date().toISOString();
  const snoozeUntil = new Date(Date.now() + duration_hours * 3600_000).toISOString();

  const { data, error } = await supabase
    .from("conversations")
    .update({ snooze_until: snoozeUntil, snoozed_at: nowIso, snoozed_by_user_id: actorUserId })
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  void audit({
    action: "conversation.snoozed",
    actorUserId,
    actorApiTokenId,
    organizationId,
    resourceType: "conversation",
    resourceId: data.id,
    requestId,
    metadata: { duration_hours },
  });
  return ok({ snooze_until: snoozeUntil }, { requestId });
}

export async function DELETE(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await params;

  const authHeader = _req.headers.get("authorization");
  if (authHeader && /^Bearer\s+/i.test(authHeader.trim())) {
    const authz = await resolveAuthDual(_req, {
      requestId,
      resource: "conversations",
      role: "agent",
      scope: "mcp:write",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "conversations", requestId);
    if (teto) return teto;
    const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
    const { organizationId } = authz;
    const supabase = authz.supabase;
    const actorId = authz.actor.type === "user" ? authz.actor.id : null;
    return responderSnoozeDelete(supabase, organizationId, id, requestId, t, actorId, authz.apiTokenId ?? null);
  }

  // Caminho de sessão: byte a byte igual.
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const supabase = await createClient();
  return responderSnoozeDelete(supabase, org.orgId, id, requestId, t, user.id, null);
}

async function responderSnoozeDelete(
  supabase: SupabaseClient,
  organizationId: string,
  conversationId: string,
  requestId: string,
  t: (texto: string) => string,
  actorUserId: string | null,
  actorApiTokenId: string | null,
): Promise<Response> {
  const { data, error } = await supabase
    .from("conversations")
    .update({ snooze_until: null, snoozed_at: null, snoozed_by_user_id: null })
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  void audit({
    action: "conversation.snooze_cancelled",
    actorUserId,
    actorApiTokenId,
    organizationId,
    resourceType: "conversation",
    resourceId: data.id,
    requestId,
  });
  return noContent(requestId);
}
