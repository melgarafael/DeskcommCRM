import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { advomaxAppUrl } from "@/lib/advomax/navigation";
import { env } from "@/lib/env";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

export const dynamic = "force-dynamic";

/** Inicia o vínculo com o navegador antes de visitar a identidade Advomax. */
export async function GET(): Promise<Response> {
  if (!env.ADVOMAX_API_URL || !env.ADVOMAX_CRM_INTEGRATION_KEY) {
    return NextResponse.redirect(new URL("/login?error=sso_indisponivel", env.NEXT_PUBLIC_APP_URL));
  }
  const state = randomBytes(32).toString("base64url");
  const destination = new URL("/crm/entrar", advomaxAppUrl());
  destination.searchParams.set("state", state);
  const response = NextResponse.redirect(destination);
  response.cookies.set("advomax_sso_state", state, {
    httpOnly: true, secure: cookieSecure(), sameSite: "lax", path: "/auth/advomax", maxAge: 300,
  });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
