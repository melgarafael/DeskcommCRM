/**
 * PATCH  /api/v1/message-templates/[id] — atualiza título/corpo/atalho.
 * DELETE /api/v1/message-templates/[id] — remove o template.
 *
 * O `.eq("organization_id", org.orgId)` é defesa extra, não substitui a RLS
 * `message_templates_write` — quem já não é dono (agent) nem manager (compartilhado)
 * é barrado pela policy antes de chegar aqui.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok, noContent } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { updateTemplateSchema } from "@/lib/schemas/templates";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const COLS = "id, organization_id, owner_user_id, title, body, shortcut, created_by_user_id, created_at, updated_at";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "message_templates" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const { id } = await params;

  const raw = await req.json().catch(() => null);
  const parsed = updateTemplateSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("message_templates")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select(COLS)
    .single();
  if (error || !data) return fail("not_found", "Template não encontrado.", 404, { requestId });

  void audit({
    action: "template.updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "message_template",
    resourceId: data.id,
    requestId,
    metadata: { fields: Object.keys(parsed.data) },
  });
  return ok(data, { requestId });
}

export async function DELETE(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "message_templates" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const { id } = await params;

  const supabase = await createClient();
  const { error } = await supabase
    .from("message_templates")
    .delete()
    .eq("id", id)
    .eq("organization_id", org.orgId);
  if (error) return fail("internal_error", "Erro ao excluir template.", 500, { requestId });

  void audit({
    action: "template.deleted",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "message_template",
    resourceId: id,
    requestId,
  });
  return noContent(requestId);
}
