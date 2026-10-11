/**
 * GET /api/v1/admin/tenants/[id]/members — quem pertence ao tenant, com o
 * e-mail de LOGIN de cada pessoa.
 *
 * O "e-mail do tenant" não é coluna de `organizations` (a única ali é
 * `dpo_email`, o encarregado LGPD): é o e-mail com que cada membro entra, e ele
 * mora só em `auth.users`. Por isso a lista junta `user_organizations` (papel,
 * situação do vínculo) com o GoTrue (e-mail, último acesso) — é daqui que a tela
 * oferece a troca de e-mail de quem se cadastrou com o endereço errado.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";

export interface MembroDoTenant {
  user_id: string;
  email: string | null;
  role: string;
  accepted_at: string | null;
  revoked_at: string | null;
  last_sign_in_at: string | null;
  is_platform_admin: boolean;
  is_owner: boolean;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return fail("not_found", "Tenant not found", 404, { requestId });
  }

  let atorId: string;
  try {
    atorId = (await requirePlatformAdmin()).user.id;
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const admin = createAdminClient();
  const [{ data: org }, { data: vinculos, error }] = await Promise.all([
    admin.from("organizations").select("id, created_by").eq("id", id).maybeSingle(),
    admin
      .from("user_organizations")
      .select("user_id, role, accepted_at, revoked_at")
      .eq("organization_id", id)
      .order("accepted_at", { ascending: true, nullsFirst: true }),
  ]);
  if (!org) return fail("not_found", "Tenant not found", 404, { requestId });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const ids = (vinculos ?? []).map((v) => v.user_id as string);
  const { data: admins } = ids.length
    ? await admin
        .from("platform_admins")
        .select("user_id")
        .in("user_id", ids)
        .is("revoked_at", null)
    : { data: [] as { user_id: string }[] };
  const deAdmins = new Set((admins ?? []).map((a) => a.user_id as string));

  const membros: MembroDoTenant[] = await Promise.all(
    (vinculos ?? []).map(async (v) => {
      const { data } = await admin.auth.admin.getUserById(v.user_id as string);
      return {
        user_id: v.user_id as string,
        email: data?.user?.email ?? null,
        role: v.role as string,
        accepted_at: (v.accepted_at as string | null) ?? null,
        revoked_at: (v.revoked_at as string | null) ?? null,
        last_sign_in_at: data?.user?.last_sign_in_at ?? null,
        is_platform_admin: deAdmins.has(v.user_id as string),
        is_owner: org.created_by === v.user_id,
      };
    }),
  );

  // A lista expõe e-mails (dado pessoal) de uma organização a quem não é dela:
  // a leitura fica registrada, como a do detalhe do tenant.
  void audit({
    action: "platform_admin.tenant_members_viewed",
    actorUserId: atorId,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: id,
    resourceType: "organization",
    resourceId: id,
    requestId,
    metadata: { quantidade: membros.length },
  });

  return ok({ members: membros }, { requestId });
}
