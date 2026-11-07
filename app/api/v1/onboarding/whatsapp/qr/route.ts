import { loadOnboardingChannel } from "@/lib/channels/onboarding-session";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { loadAuthUser } from "@/lib/auth/server";
import { orgAtivaDaApi } from "@/lib/auth/require-role";
import { comIdDaRequisicao } from "@/lib/api/wrappers";

/**
 * Proxy WAHA's QR endpoint so the browser can <img src="..." /> without
 * exposing the API key.
 *
 * WAHA exposes: GET /api/{session}/auth/qr?format=image → image/png bytes.
 */
export async function GET(req: Request) {
  const user = await loadAuthUser();
  if (!user) return comIdDaRequisicao(new NextResponse(null, { status: 401 }), req);
  const ativa = await orgAtivaDaApi(user);
  if (!ativa.ok) return ativa.response;
  const activeOrg = ativa.org;
  if (!activeOrg) return comIdDaRequisicao(new NextResponse(null, { status: 404 }), req);

  const baseUrl = process.env.WAHA_API_BASE_URL;
  const apiKey = process.env.WAHA_API_KEY;
  if (!baseUrl || !apiKey || apiKey === "dev_plaintext_change_me") {
    return comIdDaRequisicao(new NextResponse(null, { status: 503 }), req);
  }

  const channel = await loadOnboardingChannel(await createClient(), activeOrg.orgId);
  if (!channel || channel.archived_at) return comIdDaRequisicao(new NextResponse(null, { status: 404 }), req);
  const sessionName = channel.waha_session_name;
  const upstream = await fetch(
    `${baseUrl}/api/${encodeURIComponent(sessionName)}/auth/qr?format=image`,
    { headers: { "X-Api-Key": apiKey }, cache: "no-store" },
  );
  if (!upstream.ok) {
    return comIdDaRequisicao(new NextResponse(null, {
      status: upstream.status,
      headers: { "x-waha-status": String(upstream.status) },
    }), req);
  }

  const ct = upstream.headers.get("content-type") ?? "image/png";
  const buf = await upstream.arrayBuffer();
  return comIdDaRequisicao(new NextResponse(buf, {
    status: 200,
    headers: {
      "content-type": ct,
      "cache-control": "no-store, max-age=0",
    },
  }), req);
}
