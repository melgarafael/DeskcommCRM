"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { requireRole } from "@/lib/auth/require-role";
import { ensureTenantForUser } from "@/lib/auth/provision";
import { createAdminClient } from "@/lib/supabase/admin";

const inputSchema = z.object({ requestId: z.string().uuid(), decision: z.enum(["approve", "reject"]) });

export async function decideOrganizationRegistration(input: z.input<typeof inputSchema>) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Solicitação inválida." };
  const { user } = await requirePlatformAdmin();
  const admin = createAdminClient();
  const { data: request, error } = await admin.from("registration_requests").select("*")
    .eq("id", parsed.data.requestId).eq("kind", "create_organization").eq("status", "pending").maybeSingle();
  if (error || !request) return { ok: false as const, error: "Solicitação não encontrada ou já decidida." };

  if (parsed.data.decision === "approve") {
    const { data: auth } = await admin.auth.admin.getUserById(request.user_id);
    if (!auth.user) return { ok: false as const, error: "A conta deste cadastro não existe mais." };
    await ensureTenantForUser({ id: auth.user.id, email: auth.user.email, user_metadata: { org_name: request.requested_organization_name } });
  }
  const now = new Date().toISOString();
  const { error: updateError } = await admin.from("registration_requests").update({
    status: parsed.data.decision === "approve" ? "approved" : "rejected", decided_by: user.id, decided_at: now,
  }).eq("id", request.id).eq("status", "pending");
  if (updateError) return { ok: false as const, error: "Não foi possível registrar a decisão." };
  const h = await headers();
  await audit({ action: parsed.data.decision === "approve" ? "registration.approved" : "registration.rejected", actorUserId: user.id, resourceType: "registration_request", resourceId: request.id, requestId: h.get("x-request-id") ?? undefined, actingAsPlatformAdmin: true, metadata: { kind: request.kind } });
  revalidatePath("/app/settings/cadastros");
  return { ok: true as const };
}

export async function decideJoinRegistration(input: z.input<typeof inputSchema>) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Solicitação inválida." };
  const authz = await requireRole("admin", { resource: "team" });
  if (!authz.ok) return { ok: false as const, error: "Sem permissão para aprovar." };
  const admin = createAdminClient();
  const { data: request, error } = await admin.from("registration_requests").select("*")
    .eq("id", parsed.data.requestId).eq("kind", "join_organization").eq("requested_organization_id", authz.org.orgId).eq("status", "pending").maybeSingle();
  if (error || !request) return { ok: false as const, error: "Solicitação não encontrada ou já decidida." };
  if (parsed.data.decision === "approve") {
    const { error: membershipError } = await admin.from("user_organizations").upsert({ user_id: request.user_id, organization_id: authz.org.orgId, role: "agent", accepted_at: new Date().toISOString(), revoked_at: null }, { onConflict: "user_id,organization_id" });
    if (membershipError) return { ok: false as const, error: "Não foi possível conceder o acesso." };
  }
  const { error: updateError } = await admin.from("registration_requests").update({ status: parsed.data.decision === "approve" ? "approved" : "rejected", decided_by: authz.user.id, decided_at: new Date().toISOString() }).eq("id", request.id).eq("status", "pending");
  if (updateError) return { ok: false as const, error: "Não foi possível registrar a decisão." };
  await audit({ action: parsed.data.decision === "approve" ? "registration.approved" : "registration.rejected", actorUserId: authz.user.id, organizationId: authz.org.orgId, resourceType: "registration_request", resourceId: request.id, metadata: { kind: request.kind } });
  revalidatePath("/app/team");
  return { ok: true as const };
}
