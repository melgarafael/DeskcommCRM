import { type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { enrichCompanyHandler } from "@/lib/crm-b2b/companies-handler";
import {
  ctxFromAuthz,
  handleRouteError,
  ok,
  requestIdOf,
} from "@/lib/crm-b2b/route-helpers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/companies/:id/enrich — reprocessa BrasilAPI (manager+). */
export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = requestIdOf(req);
  const authz = await requireRole("manager", { requestId, resource: "companies" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  try {
    const supabase = await createClient();
    const data = await enrichCompanyHandler(
      supabase,
      ctxFromAuthz(authz, requestId),
      authz.user.id,
      id,
    );
    return ok(data, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}
