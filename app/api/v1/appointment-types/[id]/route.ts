import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  duration_minutes: z.number().int().positive().optional(),
  responsible_user_id: z.string().uuid().optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/).nullable().optional(),
  is_active: z.boolean().optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "appointment_types" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = patchSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }

  const admin = createAdminClient();

  // responsible_user_id vem do body — nunca confiar sem provar que é membro
  // ativo desta org (mesmo padrão de app/api/v1/conversations/[id]/transfer/route.ts).
  if (parsed.data.responsible_user_id) {
    const { data: member, error: memberErr } = await admin
      .from("user_organizations")
      .select("role")
      .eq("organization_id", authz.org.orgId)
      .eq("user_id", parsed.data.responsible_user_id)
      .is("revoked_at", null)
      .maybeSingle();
    if (memberErr) return fail("internal_error", memberErr.message, 500, { requestId });
    if (!member) {
      return fail(
        "unprocessable_entity",
        "responsible_user_id não é membro ativo desta organização.",
        422,
        { requestId },
      );
    }
  }

  const { error } = await admin
    .from("appointment_types")
    .update(parsed.data)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId);

  if (error) return fail("internal_error", "Erro ao atualizar tipo de agendamento.", 500, { requestId });

  void audit({
    action: "appointment_type.updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "appointment_types",
    resourceId: id,
    requestId,
    metadata: parsed.data,
  });

  return ok({ id }, { requestId });
}

export async function DELETE(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "appointment_types" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;

  const admin = createAdminClient();

  // Não deixa apagar tipo com agendamento futuro — arquivar (is_active=false)
  // é o caminho normal, mesmo espírito de "arquivar em vez de apagar" já
  // usado em funis.
  const { count, error: countErr } = await admin
    .from("appointments")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", authz.org.orgId)
    .eq("appointment_type_id", id)
    .eq("status", "scheduled")
    .gte("scheduled_at", new Date().toISOString());

  if (countErr) return fail("internal_error", "Erro ao verificar agendamentos.", 500, { requestId });
  if ((count ?? 0) > 0) {
    return fail(
      "type_has_future_appointments",
      "Este tipo tem agendamentos futuros — cancele-os ou arquive o tipo (is_active=false) em vez de excluir.",
      409,
      { requestId },
    );
  }

  const { error } = await admin
    .from("appointment_types")
    .delete()
    .eq("id", id)
    .eq("organization_id", authz.org.orgId);

  if (error) return fail("internal_error", "Erro ao excluir tipo de agendamento.", 500, { requestId });

  void audit({
    action: "appointment_type.deleted",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "appointment_types",
    resourceId: id,
    requestId,
  });

  return ok({ id }, { requestId });
}
