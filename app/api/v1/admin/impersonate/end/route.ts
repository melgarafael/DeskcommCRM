import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { IMPERSONATE_COOKIE_NAME } from "@/lib/impersonate/cookie";

/** A própria sessão pode sair depois de expiração/revogação de plataforma. */
export async function POST() {
  const requestId = randomUUID();
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return fail("unauthenticated", "Entre novamente.", 401, { requestId });
  const { data: claims } = await db.auth.getClaims();
  const sessionId = claims?.claims.session_id;
  if (!z.string().uuid().safeParse(sessionId).success) return fail("unauthenticated", "Sessão inválida.", 401, { requestId });
  const { data: session, error } = await createAdminClient().rpc("fn_end_support", { p_actor: user.id, p_session: sessionId });
  if (error) return fail("upstream_unavailable", "Não foi possível encerrar o acompanhamento. Tente novamente.", 503, { requestId });
  const store = await cookies();
  store.delete(IMPERSONATE_COOKIE_NAME);
  if (session?.previous_organization_id) store.set("active_org", session.previous_organization_id,
    { httpOnly: true, secure: cookieSecure(), sameSite: "strict", path: "/", maxAge: 60*60*24*30 });
  if (session?.id) await audit({ action: "platform_admin.impersonate_ended", actorUserId: user.id,
    actingAsPlatformAdmin: true, bypassedRls: true, organizationId: session.organization_id,
    resourceType: "organization", resourceId: session.organization_id, requestId,
    metadata: { auth_session_id: sessionId, support_session_id: session.id, access_mode: session.access_mode } });
  return ok({ ended: !!session?.id, redirect_url: "/app/inbox" }, { requestId });
}
