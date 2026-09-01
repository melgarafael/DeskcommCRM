import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const timeSchema = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);

const blockSchema = z
  .object({
    day_of_week: z.number().int().min(0).max(6),
    starts_at: timeSchema,
    ends_at: timeSchema,
  })
  .refine((b) => b.ends_at > b.starts_at, { message: "ends_at deve ser depois de starts_at" });

const putSchema = z.object({
  user_id: z.string().uuid(),
  blocks: z.array(blockSchema),
});

const getQuerySchema = z.object({
  user_id: z.string().uuid().optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "attendant_schedule" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const parsedQuery = getQuerySchema.safeParse({
    user_id: url.searchParams.get("user_id") ?? undefined,
  });
  if (!parsedQuery.success) {
    return fail("validation_failed", "Query inválida.", 422, {
      details: parsedQuery.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }
  const userId = parsedQuery.data.user_id ?? authz.user.id;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("attendant_schedule")
    .select("day_of_week, starts_at, ends_at")
    .eq("organization_id", authz.org.orgId)
    .eq("user_id", userId)
    .order("day_of_week", { ascending: true });

  if (error) return fail("internal_error", "Erro ao consultar horário.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "attendant_schedule" });
  if (!authz.ok) return authz.response;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = putSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }

  const editandoOutraPessoa = parsed.data.user_id !== authz.user.id;
  const podeEditarOutro = authz.org.role === "manager" || authz.org.role === "admin";
  if (editandoOutraPessoa && !podeEditarOutro) {
    return fail("forbidden_role", "Só é possível editar o próprio horário.", 403, { requestId });
  }

  const admin = createAdminClient();

  // user_id vem do body — quando é edição de terceiro (só manager/admin chega
  // aqui), prova que o alvo é membro ativo desta org antes de gravar (mesmo
  // padrão de app/api/v1/conversations/[id]/transfer/route.ts). Edição do
  // próprio horário não precisa: authz já garantiu que o autor é membro.
  if (editandoOutraPessoa) {
    const { data: member, error: memberErr } = await admin
      .from("user_organizations")
      .select("role")
      .eq("organization_id", authz.org.orgId)
      .eq("user_id", parsed.data.user_id)
      .is("revoked_at", null)
      .maybeSingle();
    if (memberErr) return fail("internal_error", memberErr.message, 500, { requestId });
    if (!member) {
      return fail("unprocessable_entity", "user_id não é membro ativo desta organização.", 422, { requestId });
    }
  }

  // Substitui o conjunto inteiro da semana desta pessoa — mais simples que
  // diff incremental, e o payload já vem com a semana completa da tela.
  const { error: delErr } = await admin
    .from("attendant_schedule")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("user_id", parsed.data.user_id);
  if (delErr) return fail("internal_error", "Erro ao limpar horário anterior.", 500, { requestId });

  if (parsed.data.blocks.length > 0) {
    const { error: insErr } = await admin.from("attendant_schedule").insert(
      parsed.data.blocks.map((b) => ({
        organization_id: authz.org.orgId,
        user_id: parsed.data.user_id,
        day_of_week: b.day_of_week,
        starts_at: b.starts_at,
        ends_at: b.ends_at,
      })),
    );
    if (insErr) return fail("internal_error", "Erro ao salvar horário.", 500, { requestId });
  }

  void audit({
    action: "attendant_schedule.updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "attendant_schedule",
    resourceId: parsed.data.user_id,
    requestId,
    metadata: { blocks_count: parsed.data.blocks.length },
  });

  return ok({ user_id: parsed.data.user_id, blocks: parsed.data.blocks }, { requestId });
}
