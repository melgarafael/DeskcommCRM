import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import type { User } from "@supabase/supabase-js";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

export const dynamic = "force-dynamic";
const handoffSchema = z.object({
  email: z.string().email().max(254), nome: z.string().nullable(),
  usuarioCodigo: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  empresaCodigo: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  empresaNome: z.string().min(1).max(255),
  crmOrganizationId: z.string().uuid().nullable(),
  perfilCodigo: z.number().int().nullable(), produto: z.literal("crm"),
});

function redirect(path: string) {
  const response = NextResponse.redirect(new URL(path, env.NEXT_PUBLIC_APP_URL));
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
const fail = (reason: string) => redirect(`/login?error=${reason}`);

/** Código e state só são aceitos no navegador que iniciou a autenticação. */
export async function GET(request: NextRequest): Promise<Response> {
  const code = request.nextUrl.searchParams.get("code") ?? "";
  const state = request.nextUrl.searchParams.get("state") ?? "";
  const browserState = request.cookies.get("advomax_sso_state")?.value ?? "";
  if (![code, state, browserState].every((value) => /^[A-Za-z0-9_-]{43}$/.test(value)) ||
    !timingSafeEqual(Buffer.from(state), Buffer.from(browserState))) return fail("sso_invalido");
  if (!env.ADVOMAX_API_URL || !env.ADVOMAX_CRM_INTEGRATION_KEY) return fail("sso_indisponivel");

  const store = await cookies();
  store.set("advomax_sso_state", "", { path: "/auth/advomax", maxAge: 0, httpOnly: true, sameSite: "lax", secure: cookieSecure() });
  try {
    const base = env.ADVOMAX_API_URL.replace(/\/$/, "");
    const headers = { "Content-Type": "application/json", "X-CRM-Integration-Key": env.ADVOMAX_CRM_INTEGRATION_KEY };
    const redeemed = await fetch(`${base}/suite/v1/session/handoff/redeem`, {
      method: "POST", headers, body: JSON.stringify({ code, state }), signal: AbortSignal.timeout(15_000), cache: "no-store",
    });
    if (!redeemed.ok) return fail("sso_expirado");
    const parsed = handoffSchema.safeParse(await redeemed.json());
    if (!parsed.success) return fail("sso_invalido");
    const handoff = parsed.data;
    const admin = createAdminClient();
    const session = await createClient();

    // ponytail: busca paginada no Auth; índice de identidade dedicado quando o volume exigir.
    let mappedUser: User | undefined;
    let emailUser: User | undefined;
    for (let page = 1; ; page++) {
      const users = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (users.error) return fail("sso_provisionamento");
      for (const candidate of users.data.users) {
        if (candidate.app_metadata.advomax_user_codigo === handoff.usuarioCodigo) {
          if (mappedUser && mappedUser.id !== candidate.id) return fail("sso_identidade");
          mappedUser = candidate;
        }
        if (candidate.email?.toLowerCase() === handoff.email.toLowerCase()) emailUser = candidate;
      }
      if (!users.data.nextPage) break;
    }
    if (mappedUser && emailUser && mappedUser.id !== emailUser.id) return fail("sso_identidade");
    let user = mappedUser ?? emailUser;
    if (user && user.app_metadata.advomax_user_codigo !== handoff.usuarioCodigo) {
      // Uma conta CRM existente só pode ser associada após prova da sessão
      // CRM. O e-mail do handoff, sozinho, não autoriza tomar essa conta.
      if (user.app_metadata.advomax_user_codigo != null || !user.email_confirmed_at) return fail("sso_identidade");
      const current = await session.auth.getUser();
      if (current.error || current.data.user?.id !== user.id) return fail("sso_identidade");
    }
    if (!user && handoff.perfilCodigo !== 1) return fail("sso_convite");
    const identity = { advomax_user_codigo: handoff.usuarioCodigo, advomax_empresa_codigo: handoff.empresaCodigo };
    if (!user) {
      const created = await admin.auth.admin.createUser({ email: handoff.email, email_confirm: true,
        app_metadata: identity, user_metadata: { full_name: handoff.nome ?? undefined } });
      if (created.error || !created.data.user) return fail("sso_provisionamento");
      user = created.data.user;
    } else {
      const updated = await admin.auth.admin.updateUserById(user.id, {
        email: handoff.email, email_confirm: true, app_metadata: { ...user.app_metadata, ...identity },
      });
      if (updated.error) return fail("sso_identidade");
    }
    const userId = user.id;
    let organizationId = handoff.crmOrganizationId;
    if (!organizationId) {
      const mapped = await admin.from("organizations").select("id").eq("advomax_empresa_codigo", handoff.empresaCodigo).maybeSingle();
      if (mapped.error) return fail("sso_organizacao");
      organizationId = mapped.data?.id ?? null;
      if (!organizationId) {
        if (handoff.perfilCodigo !== 1) return fail("sso_convite");
        const inserted = await admin.from("organizations").insert({
          slug: `advomax-${handoff.empresaCodigo}`, display_name: handoff.empresaNome, legal_name: handoff.empresaNome,
          status: "active", created_by: userId, advomax_empresa_codigo: handoff.empresaCodigo,
        }).select("id").single();
        if (inserted.error?.code === "23505") {
          const concurrent = await admin.from("organizations").select("id").eq("advomax_empresa_codigo", handoff.empresaCodigo).maybeSingle();
          if (concurrent.error) return fail("sso_organizacao");
          organizationId = concurrent.data?.id ?? null;
        } else if (inserted.error) return fail("sso_organizacao");
        else organizationId = inserted.data?.id ?? null;
      }
    }
    if (!organizationId) return fail("sso_organizacao");
    const org = await admin.from("organizations").select("id,status,advomax_empresa_codigo,created_by").eq("id", organizationId).maybeSingle();
    if (org.error || !org.data || org.data.status !== "active" ||
      org.data.advomax_empresa_codigo !== handoff.empresaCodigo) return fail("sso_organizacao");

    if (!handoff.crmOrganizationId) {
      const mapped = await fetch(`${base}/integracoes/crm/provisionar`, {
        method: "POST", headers, body: JSON.stringify({ empresaCodigo: handoff.empresaCodigo, crmOrganizationId: organizationId }),
        signal: AbortSignal.timeout(15_000), cache: "no-store",
      });
      // Resposta perdida pode ter confirmado o vínculo. Preservar a org permite retry.
      if (!mapped.ok) return fail("sso_provisionamento");
    }

    const membershipQuery = () => admin.from("user_organizations").select("id,revoked_at,accepted_at")
      .eq("organization_id", organizationId).eq("user_id", userId).maybeSingle();
    let membership = await membershipQuery();
    if (membership.error) return fail("sso_membership");
    if (!membership.data) {
      // Só o criador inicial recebe admin; equipe e demais admins precisam de convite.
      if (handoff.perfilCodigo !== 1 || org.data.created_by !== userId) return fail("sso_convite");
      const inserted = await admin.from("user_organizations").insert({ user_id: userId, organization_id: organizationId,
        role: "admin", accepted_at: new Date().toISOString() });
      if (inserted.error && inserted.error.code !== "23505") return fail("sso_membership");
      membership = await membershipQuery();
    }
    if (membership.error || !membership.data || membership.data.revoked_at || !membership.data.accepted_at) return fail("sso_membership");

    const link = await admin.auth.admin.generateLink({ type: "magiclink", email: handoff.email });
    const tokenHash = link.data.properties?.hashed_token;
    if (link.error || !tokenHash || link.data.user?.id !== userId) return fail("sso_sessao");
    // verifyOtp no cliente SSR grava cookies. action_link redirecionaria sem PKCE local.
    const verified = await session.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
    if (verified.error || !verified.data.session || verified.data.user?.id !== userId) {
      if (verified.data.session) await session.auth.signOut({ scope: "local" });
      return fail("sso_sessao");
    }
    store.set("active_org", organizationId, { httpOnly: true, secure: cookieSecure(), sameSite: "strict", path: "/", maxAge: 60 * 60 * 24 * 30 });
    await audit({ action: "auth.login_success", actorUserId: userId, organizationId,
      metadata: { source: "advomax_handoff" }, requestId: request.headers.get("x-request-id") });
    return redirect("/app");
  } catch {
    return fail("sso_provisionamento");
  }
}
