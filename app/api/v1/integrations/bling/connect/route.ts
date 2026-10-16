import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitirEstadoBling } from "@/lib/integrations/bling/state";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "bling_integration" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const orgId = authz.org.orgId;
  const userId = authz.user.id;

  const { data, error } = await admin
    .from("bling_integrations")
    .select("client_id")
    .eq("organization_id", orgId)
    .maybeSingle();

  if (error || !data || !data.client_id) {
    const errorUrl = new URL("/app/settings/bling?error=missing_client_id", req.nextUrl.origin);
    return NextResponse.redirect(errorUrl);
  }

  const state = emitirEstadoBling(orgId, userId);
  const redirectUri = `${req.nextUrl.origin}/api/v1/integrations/bling/callback`;

  const authorizeUrl = new URL("https://www.bling.com.br/Api/v3/oauth/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", data.client_id);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);

  return NextResponse.redirect(authorizeUrl.toString());
}
