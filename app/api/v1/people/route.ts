import { type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import {
  createPersonHandler,
  listPeopleHandler,
} from "@/lib/crm-b2b/people-handler";
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
  const authz = await requireRole("viewer", { requestId, resource: "people" });
  if (!authz.ok) return authz.response;

  try {
    const supabase = await createClient();
    const search = req.nextUrl.searchParams.get("search") ?? undefined;
    const limit = Number(req.nextUrl.searchParams.get("limit") ?? "50");
    const result = await listPeopleHandler(
      supabase,
      ctxFromAuthz(authz, requestId),
      { search, limit },
    );
    return ok(result.people, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = requestIdOf(req);
  const authz = await requireRole("manager", { requestId, resource: "people" });
  if (!authz.ok) return authz.response;

  try {
    const body = await req.json();
    const supabase = await createClient();
    const data = await createPersonHandler(
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
