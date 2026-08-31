import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  duration_minutes: z.number().int().positive(),
  responsible_user_id: z.string().uuid(),
  color: z.string().regex(/^#[0-9a-f]{6}$/).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "appointment_types" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("appointment_types")
    .select("id, name, duration_minutes, responsible_user_id, color, is_active")
    .eq("organization_id", authz.org.orgId)
    .order("name", { ascending: true });

  if (error) return fail("internal_error", "Erro ao listar tipos de agendamento.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "appointment_types" });
  if (!authz.ok) return authz.response;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = createSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();

  // responsible_user_id vem do body — nunca confiar sem provar que é membro
  // ativo desta org (mesmo padrão de app/api/v1/conversations/[id]/transfer/route.ts).
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

  const { data, error } = await admin
    .from("appointment_types")
    .insert({ organization_id: authz.org.orgId, ...parsed.data })
    .select("id")
    .single();

  if (error || !data) {
    return fail("internal_error", "Erro ao criar tipo de agendamento.", 500, { requestId });
  }

  void audit({
    action: "appointment_type.created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "appointment_types",
    resourceId: (data as { id: string }).id,
    requestId,
    metadata: { name: parsed.data.name },
  });

  return ok({ id: (data as { id: string }).id }, { status: 201, requestId });
}
