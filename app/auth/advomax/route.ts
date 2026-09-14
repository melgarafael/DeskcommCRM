/** GET /auth/advomax — redeems an Advomax one-time code into a CRM session. */
import { NextResponse, type NextRequest } from "next/server";

import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Handoff = {
  email: string;
  nome: string | null;
  usuarioCodigo: number;
  empresaCodigo: number;
  empresaNome: string;
  crmOrganizationId: string | null;
  perfilCodigo: number | null;
  produto: string;
};

function fail(reason: string) {
  const url = new URL("/login", env.NEXT_PUBLIC_APP_URL);
  url.searchParams.set("error", reason);
  return NextResponse.redirect(url);
}

function slugify(value: string): string {
  const slug = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || "escritorio";
}

export async function GET(request: NextRequest): Promise<Response> {
  const code = request.nextUrl.searchParams.get("code")?.trim() ?? "";
  const state = request.nextUrl.searchParams.get("state")?.trim() ?? "";
  if (!code || !state || !env.ADVOMAX_API_URL || !env.ADVOMAX_CRM_INTEGRATION_KEY) return fail("sso_indisponivel");

  const base = env.ADVOMAX_API_URL.replace(/\/$/, "");
  const redeemed = await fetch(`${base}/suite/v1/session/handoff/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CRM-Integration-Key": env.ADVOMAX_CRM_INTEGRATION_KEY },
    body: JSON.stringify({ code, state }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!redeemed?.ok) return fail("sso_expirado");
  const handoff = await redeemed.json().catch(() => null) as Handoff | null;
  if (!handoff?.email || handoff.produto !== "crm") return fail("sso_invalido");

  const admin = createAdminClient();
  const users = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (users.error) return fail("sso_provisionamento");
  let user = users.data.users.find((item) => item.email?.toLowerCase() === handoff.email.toLowerCase()) ?? null;
  if (!user) {
    const created = await admin.auth.admin.createUser({
      email: handoff.email,
      email_confirm: true,
      user_metadata: { advomax_user_codigo: handoff.usuarioCodigo, advomax_empresa_codigo: handoff.empresaCodigo, full_name: handoff.nome ?? undefined },
    });
    if (created.error || !created.data.user) return fail("sso_provisionamento");
    user = created.data.user;
  } else {
    await admin.auth.admin.updateUserById(user.id, { user_metadata: { ...user.user_metadata, advomax_user_codigo: handoff.usuarioCodigo, advomax_empresa_codigo: handoff.empresaCodigo, full_name: handoff.nome ?? user.user_metadata?.full_name } });
  }

  let organizationId = handoff.crmOrganizationId;
  let createdOrganization = false;
  if (organizationId) {
    const existing = await admin.from("organizations" as never).select("id").eq("id", organizationId).maybeSingle();
    if (!existing.data || existing.error) return fail("sso_organizacao");
  } else {
    const mapped = await admin.from("organizations" as never).select("id").eq("advomax_empresa_codigo", handoff.empresaCodigo).maybeSingle();
    if (mapped.error) return fail("sso_organizacao");
    if (mapped.data) {
      organizationId = (mapped.data as { id: string }).id;
    } else {
      const baseSlug = slugify(handoff.empresaNome);
      for (let attempt = 0; attempt < 3 && !organizationId; attempt++) {
        const slug = attempt === 0 ? baseSlug : `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
        const inserted = await admin.from("organizations" as never).insert({ slug, display_name: handoff.empresaNome, legal_name: handoff.empresaNome, status: "active", created_by: user.id, advomax_empresa_codigo: handoff.empresaCodigo } as never).select("id").single() as unknown as { data: { id: string } | null; error: { code?: string } | null };
        if (inserted.data) { organizationId = (inserted.data as { id: string }).id; createdOrganization = true; break; }
        if (inserted.error?.code !== "23505") return fail("sso_organizacao");
      }
      if (!organizationId) return fail("sso_organizacao");
    }
  }

  const membership = await admin.from("user_organizations" as never).select("id,revoked_at").eq("organization_id", organizationId).eq("user_id", user.id).maybeSingle();
  if (membership.error) return fail("sso_membership");
  const role = handoff.perfilCodigo === 1 ? "admin" : "manager";
  if (!membership.data) {
    const inserted = await admin.from("user_organizations" as never).insert({ user_id: user.id, organization_id: organizationId, role, accepted_at: new Date().toISOString() } as never);
    if (inserted.error) return fail("sso_membership");
  } else if ((membership.data as { revoked_at: string | null }).revoked_at) {
    const reactivated = await admin.from("user_organizations" as never).update({ role, revoked_at: null, accepted_at: new Date().toISOString() } as never).eq("id", (membership.data as { id: string }).id);
    if (reactivated.error) return fail("sso_membership");
  }

  if (!handoff.crmOrganizationId) {
    const mapped = await fetch(`${base}/integracoes/crm/provisionar`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CRM-Integration-Key": env.ADVOMAX_CRM_INTEGRATION_KEY },
      body: JSON.stringify({ empresaCodigo: handoff.empresaCodigo, crmOrganizationId: organizationId }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!mapped?.ok) {
      if (createdOrganization) await admin.from("organizations" as never).delete().eq("id", organizationId);
      return fail("sso_provisionamento");
    }
  }

  const redirectTo = `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/auth/confirm?type=magiclink&next=/app`;
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: handoff.email, options: { redirectTo } });
  if (link.error || !link.data.properties?.action_link) return fail("sso_sessao");
  return NextResponse.redirect(link.data.properties.action_link);
}
