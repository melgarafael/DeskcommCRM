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
import { requireRole } from "@/lib/auth/require-role";
import { snoozeSchema } from "@/lib/schemas/snooze";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const { id } = await params;

  const raw = await req.json().catch(() => null);
  const parsed = snoozeSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { duration_hours } = parsed.data;

  const nowIso = new Date().toISOString();
  const snoozeUntil = new Date(Date.now() + duration_hours * 3600_000).toISOString();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("conversations")
    .update({ snooze_until: snoozeUntil, snoozed_at: nowIso, snoozed_by_user_id: user.id })
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select("id")
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", "Conversa não encontrada.", 404, { requestId });

  void audit({
    action: "conversation.snoozed",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "conversation",
    resourceId: data.id,
    requestId,
    metadata: { duration_hours },
  });
  return ok({ snooze_until: snoozeUntil }, { requestId });
}

export async function DELETE(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const { id } = await params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("conversations")
    .update({ snooze_until: null, snoozed_at: null, snoozed_by_user_id: null })
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select("id")
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", "Conversa não encontrada.", 404, { requestId });

  void audit({
    action: "conversation.snooze_cancelled",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "conversation",
    resourceId: data.id,
    requestId,
  });
  return noContent(requestId);
}
