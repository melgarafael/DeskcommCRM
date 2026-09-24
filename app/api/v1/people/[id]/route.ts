import { type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { getPersonHandler, patchPersonHandler } from "@/lib/crm-b2b/people-handler";
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
  const authz = await requireRole("viewer", { requestId, resource: "people" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  try {
    const supabase = await createClient();
    const data = await getPersonHandler(supabase, ctxFromAuthz(authz, requestId), id);
    return ok(data, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}

export async function PATCH(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = requestIdOf(req);
  const authz = await requireRole("agent", { requestId, resource: "people" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  try {
    const body = await req.json();
    const supabase = await createClient();
    const data = await patchPersonHandler(
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
