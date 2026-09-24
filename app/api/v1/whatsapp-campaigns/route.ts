import { type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import {
  createCampaignHandler,
  listCampaignsHandler,
} from "@/lib/whatsapp-campaigns/handlers";
import {
  ctxFromAuthz,
  handleRouteError,
  ok,
  requestIdOf,
} from "@/lib/crm-b2b/route-helpers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = requestIdOf(req);
  const authz = await requireRole("viewer", { requestId, resource: "whatsapp_campaigns" });
  if (!authz.ok) return authz.response;
  try {
    const supabase = await createClient();
    const data = await listCampaignsHandler(supabase, ctxFromAuthz(authz, requestId));
    return ok(data, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = requestIdOf(req);
  const authz = await requireRole("manager", { requestId, resource: "whatsapp_campaigns" });
  if (!authz.ok) return authz.response;
  try {
    const body = await req.json();
    const supabase = await createClient();
    const data = await createCampaignHandler(
      supabase,
      ctxFromAuthz(authz, requestId),
      authz.user.id,
      body,
    );
    return ok(data, { requestId, status: 201 });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}
