import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buscarPessoasAdvomax,
  PEOPLE_PAGE_SIZE,
  sincronizarClientesAdvomax,
} from "@/lib/advomax/people-sync";
import { verificarAcessoCrmDaOrganizacao } from "@/lib/advomax/licenca";

export {
  prepararClientesAdvomax,
  emailValidoOuNull,
  lotesDeTelefones,
} from "@/lib/advomax/people-sync";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "advomax_people_sync" });
  if (!authz.ok) return authz.response;

  const offset = Number(req.nextUrl.searchParams.get("offset") ?? "0");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000 || offset % PEOPLE_PAGE_SIZE !== 0) {
    return fail("validation_failed", "Página inválida.", 422, { requestId });
  }

  const admin = createAdminClient();
  const { data: organization, error: organizationError } = await admin.from("organizations" as never)
    .select("status,advomax_empresa_codigo").eq("id", authz.org.orgId).maybeSingle();
  if (organizationError) return fail("internal_error", "Não foi possível validar a organização para a sincronização.", 500, { requestId });
  const org = organization as { status?: string; advomax_empresa_codigo?: number | null } | null;
  if (!org || org.status !== "active" || !Number.isSafeInteger(org.advomax_empresa_codigo) || (org.advomax_empresa_codigo as number) <= 0) {
    return ok({ processed: 0, skipped: 1, blocked: 1, skipped_reason: "organization_unmapped" }, { requestId });
  }
  const gate = await verificarAcessoCrmDaOrganizacao(authz.user.email, authz.org.orgId, org.advomax_empresa_codigo);
  if (!gate.ok) return ok({ processed: 0, skipped: 1, blocked: 1, skipped_reason: gate.reason }, { requestId });

  const pessoas = await buscarPessoasAdvomax(authz.user.email, authz.org.orgId, offset);
  if (!pessoas) return fail("bad_gateway", "Não foi possível sincronizar os clientes do Advomax.", 502, { requestId });

  const sync = await sincronizarClientesAdvomax(admin, authz.org.orgId, authz.user.id, pessoas);
  if ("error" in sync) return fail("internal_error", sync.error, 500, { requestId });

  await audit({
    action: "contact.advomax_linked",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "advomax_contact_sync",
    metadata: sync,
    requestId,
  });
  return ok({ ...sync, has_more: pessoas.length === PEOPLE_PAGE_SIZE, next_offset: offset + pessoas.length }, { requestId });
}
