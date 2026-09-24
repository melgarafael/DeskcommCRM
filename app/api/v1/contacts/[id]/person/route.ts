import { type NextRequest } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { linkContactToPersonHandler } from "@/lib/crm-b2b/people-handler";
import {
  ctxFromAuthz,
  handleRouteError,
  ok,
  requestIdOf,
} from "@/lib/crm-b2b/route-helpers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  person_id: z.string().uuid().nullable(),
});

/** PATCH /api/v1/contacts/:id/person — associa contact a people (same org). */
export async function PATCH(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = requestIdOf(req);
  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  try {
    const body = bodySchema.parse(await req.json());
    const supabase = await createClient();
    const data = await linkContactToPersonHandler(
      supabase,
      ctxFromAuthz(authz, requestId),
      authz.user.id,
      id,
      body.person_id,
    );
    return ok(data, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}
