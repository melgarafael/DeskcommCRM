import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * Épico Operação Visível (F1) — POST: cria entrada manual de memória da org
 * (migration 0067). source='manual', status='active' direto (sem gate de
 * proposta — quem cria é já manager+).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const postSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
});

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "org_memory" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org } = authz;

  const body = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", "title e body são obrigatórios.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("org_memory_entries")
    .insert({
      organization_id: org.orgId,
      title: parsed.data.title,
      body: parsed.data.body,
      source: "manual",
      status: "active",
      created_by: authUser.id,
    })
    .select("id")
    .single();
  if (error || !data) {
    return fail("internal_error", "Erro ao criar entrada de memória.", 500, { requestId });
  }

  await audit({
    action: "ai.org_memory_entry_created",
    actorUserId: authUser.id,
    organizationId: org.orgId,
    resourceType: "org_memory_entries",
    resourceId: data.id as string,
    requestId,
  });

  return ok({ id: data.id }, { requestId });
}
