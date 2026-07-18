/**
 * PATCH /api/v1/attendants/availability/[user_id] — grava disponibilidade.
 *
 * Autz (spec 13 §5): o PRÓPRIO atendente muda a sua; manager+ muda de qualquer
 * membro da org. requireRole("agent") + checagem (user_id == auth.uid() OR
 * role>=manager). A RLS de attendant_availability (own OR manager) é backstop.
 *
 * Persistência do <AttendantStatusToggle> (spec 04 §8) + heartbeat AT-08:
 * quando is_available=true, bumpa last_heartbeat_at=now — "online" é também o
 * ping de vida (o useHeartbeat/60s do inbox chama este PATCH). O cron
 * attendant-heartbeat marca offline quem não pinga há 15min.
 *
 * org_id de fonte confiável (activeOrg do cookie), NUNCA do body. Upsert por
 * unique(organization_id, user_id).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK } from "@/lib/auth/types";
import { availabilityPatchSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const SELECT_COLS =
  "user_id, is_available, capacity, schedule, last_heartbeat_at, updated_at";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { user_id: targetUserId } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "attendant_availability" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  const isSelf = targetUserId === authUser.id;
  const isManager = ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  if (!isSelf && !isManager) {
    return fail(
      "forbidden_role",
      "Só o próprio atendente ou um manager pode alterar esta disponibilidade.",
      403,
      { requestId },
    );
  }

  let input;
  try {
    input = await validateRequest(availabilityPatchSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const supabase = await createClient();

  // Manager alterando outro: alvo tem que ser membro da org (evita linha órfã;
  // a RLS permite manager inserir qualquer user_id da própria org).
  if (!isSelf) {
    const { data: member, error: memberErr } = await supabase
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", activeOrg.orgId)
      .eq("user_id", targetUserId)
      .is("revoked_at", null)
      .maybeSingle();
    if (memberErr) return fail("internal_error", memberErr.message, 500, { requestId });
    if (!member) return fail("not_found", "Atendente não encontrado na organização.", 404, { requestId });
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    organization_id: activeOrg.orgId,
    user_id: targetUserId,
    updated_at: now,
  };
  if (input.is_available !== undefined) patch.is_available = input.is_available;
  if (input.capacity !== undefined) patch.capacity = input.capacity;
  if (input.schedule !== undefined) patch.schedule = input.schedule;
  // "online" = ping de vida (heartbeat AT-08).
  if (input.is_available === true) patch.last_heartbeat_at = now;

  const { data: row, error } = await supabase
    .from("attendant_availability")
    .upsert(patch, { onConflict: "organization_id,user_id" })
    .select(SELECT_COLS)
    .single();

  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "attendant.availability_changed",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "attendant_availability",
    resourceId: targetUserId,
    requestId,
    metadata: {
      target_user_id: targetUserId,
      changed_by_self: isSelf,
      fields_changed: Object.keys(input),
      is_available: input.is_available ?? null,
    },
  });

  return ok(row, { requestId });
}
