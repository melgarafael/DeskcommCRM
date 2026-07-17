/**
 * GET /api/v1/team/assignable — destinos válidos de transferência de conversa
 * (G3-01, ReassignDialog): membros ativos agent+ da org ativa.
 *
 * Exceção deliberada e MÍNIMA à matriz spec 13 §4 (team read = manager+): um
 * agent precisa escolher o destino pra transferir (decisão G1-06d). Exposto o
 * mínimo — user_id, nome e role. Sem e-mail, sem last_sign_in (LGPD/PII).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isServiceRoleConfigured } from "@/lib/audit";

export const dynamic = "force-dynamic";

interface AssignableMember {
  user_id: string;
  role: string;
  full_name: string | null;
}

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId; // fonte confiável (cookie validado)

  // A RLS de user_organizations só mostra o próprio membership a um agent —
  // admin client filtrado manualmente pela org resolvida acima (doutrina:
  // service role + filtro explícito de organization_id de fonte confiável).
  const client = isServiceRoleConfigured() ? createAdminClient() : await createClient();
  const { data: rows, error } = await client
    .from("user_organizations")
    .select("user_id, role")
    .eq("organization_id", orgId)
    .is("revoked_at", null)
    .neq("role", "viewer")
    .order("created_at", { ascending: true });

  if (error) return fail("internal_error", error.message, 500, { requestId });

  const memberships = (rows ?? []) as Array<{ user_id: string; role: string }>;

  if (!isServiceRoleConfigured() || memberships.length === 0) {
    const degraded: AssignableMember[] = memberships.map((m) => ({ ...m, full_name: null }));
    return ok(degraded, { requestId });
  }

  const admin = createAdminClient();
  const members: AssignableMember[] = await Promise.all(
    memberships.map(async (m) => {
      const { data: userRes } = await admin.auth.admin.getUserById(m.user_id);
      return {
        ...m,
        full_name: (userRes?.user?.user_metadata?.full_name as string | undefined) ?? null,
      };
    }),
  );
  return ok(members, { requestId });
}
