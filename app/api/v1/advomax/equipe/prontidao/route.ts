import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { verificarAcessoCrmDaOrganizacao } from "@/lib/advomax/licenca";
import { compararEquipes, parseEquipeAdvomax, type MembroCrm } from "@/lib/advomax/team-readiness";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "advomax_team_readiness" });
  if (!authz.ok) return authz.response;
  const admin = createAdminClient();
  const { data: organization, error: organizationError } = await admin.from("organizations" as never)
    .select("status,advomax_empresa_codigo").eq("id", authz.org.orgId).maybeSingle();
  const org = organization as { status?: string; advomax_empresa_codigo?: number | null } | null;
  if (organizationError) return fail("internal_error", "Não foi possível validar o escritório.", 500, { requestId });
  if (!org || org.status !== "active") return fail("forbidden", "Escritório inativo.", 403, { requestId });
  const gate = await verificarAcessoCrmDaOrganizacao(authz.user.email, authz.org.orgId, org.advomax_empresa_codigo);
  if (!gate.ok) return fail("forbidden", "Integração Advomax indisponível para este escritório.", 403, { requestId });

  const response = await fetch(`${env.ADVOMAX_API_URL.replace(/\/$/, "")}/integracoes/crm/equipe`, {
    headers: { "X-CRM-Integration-Key": env.ADVOMAX_CRM_INTEGRATION_KEY, "X-CRM-Organization-Id": authz.org.orgId, "X-CRM-User-Email": authz.user.email },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response?.ok) return fail("bad_gateway", "Não foi possível consultar a equipe no Advomax.", 502, { requestId });
  const equipe = parseEquipeAdvomax(await response.json().catch(() => null));
  if (!equipe) return fail("bad_gateway", "O Advomax devolveu uma equipe inválida.", 502, { requestId });

  const { data: memberships, error: membershipsError } = await admin.from("user_organizations")
    .select("user_id,role,revoked_at").eq("organization_id", authz.org.orgId);
  if (membershipsError) return fail("internal_error", "Não foi possível consultar os membros do CRM.", 500, { requestId });
  const locais: MembroCrm[] = [];
  for (const membership of memberships ?? []) {
    const user = await admin.auth.admin.getUserById(membership.user_id);
    const email = user.data.user?.email?.trim().toLowerCase();
    if (email) locais.push({ userId: membership.user_id, email, role: membership.role, revoked: !!membership.revoked_at });
  }
  const data = compararEquipes(equipe, locais);
  const result = ok({ total_advomax: equipe.length, total_crm: locais.filter((membro) => !membro.revoked).length, ...data }, { requestId });
  result.headers.set("Cache-Control", "private, no-store");
  return result;
}
