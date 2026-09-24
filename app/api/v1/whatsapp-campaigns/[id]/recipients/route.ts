import { type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import {
  addRecipientsHandler,
  listRecipientsHandler,
} from "@/lib/whatsapp-campaigns/handlers";
import {
  ctxFromAuthz,
  handleRouteError,
  ok,
  requestIdOf,
} from "@/lib/crm-b2b/route-helpers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = requestIdOf(req);
  const authz = await requireRole("agent", { requestId, resource: "whatsapp_campaigns" });
  if (!authz.ok) return authz.response;
  const { id } = await params;
  try {
    const status = req.nextUrl.searchParams.get("status");
    const supabase = await createClient();
    const data = await listRecipientsHandler(
      supabase,
      ctxFromAuthz(authz, requestId),
      id,
      status,
    );
    return ok(data, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}

export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = requestIdOf(req);
  const authz = await requireRole("manager", { requestId, resource: "whatsapp_campaigns" });
  if (!authz.ok) return authz.response;
  const { id } = await params;
  try {
    const body = await req.json();
    const supabase = await createClient();
    const data = await addRecipientsHandler(
      supabase,
      ctxFromAuthz(authz, requestId),
      authz.user.id,
      id,
      body,
    );
    return ok(data, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}
