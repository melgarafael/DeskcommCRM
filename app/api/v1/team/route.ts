/**
 * GET /api/v1/team — list members of the active organization.
 *
 * Strategy: prefer the service-role admin client to enrich each membership
 * row with `auth.users` data (email, full_name, last_sign_in_at). When service
 * role is not configured (dev placeholder), degrade gracefully and return
 * memberships with `email = null` — the UI can still render role/status.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isServiceRoleConfigured } from "@/lib/audit";

export const dynamic = "force-dynamic";

interface MembershipRow {
  user_id: string;
  role: string;
  invited_at: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface MemberDto extends MembershipRow {
  email: string | null;
  full_name: string | null;
  last_sign_in_at: string | null;
}

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  // spec 13 §4: team read é manager+ (viewer/agent = none; nota 7).
  const authz = await requireRole("manager", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: rows, error } = await supabase
    .from("user_organizations")
    .select("user_id, role, invited_at, accepted_at, revoked_at, created_at")
    .eq("organization_id", activeOrg.orgId)
    .is("revoked_at", null)
    .order("created_at", { ascending: true });

  if (error) return fail("internal_error", error.message, 500, { requestId });

  const members: MembershipRow[] = (rows ?? []) as MembershipRow[];

  if (!isServiceRoleConfigured() || members.length === 0) {
    const degraded: MemberDto[] = members.map((m) => ({
      ...m,
      email: null,
      full_name: null,
      last_sign_in_at: null,
    }));
    return ok(degraded, { requestId });
  }

  const admin = createAdminClient();
  const enriched: MemberDto[] = await Promise.all(
    members.map(async (m) => {
      const { data: userRes } = await admin.auth.admin.getUserById(m.user_id);
      const u = userRes?.user;
      return {
        ...m,
        email: u?.email ?? null,
        full_name: (u?.user_metadata?.full_name as string | undefined) ?? null,
        last_sign_in_at: u?.last_sign_in_at ?? null,
      };
    }),
  );
  return ok(enriched, { requestId });
}
