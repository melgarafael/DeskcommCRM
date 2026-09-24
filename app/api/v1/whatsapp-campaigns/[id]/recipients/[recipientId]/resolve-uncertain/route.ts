import { type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { resolveUncertainRecipientHandler } from "@/lib/whatsapp-campaigns/resolve-uncertain";
import {
  ctxFromAuthz,
  handleRouteError,
  ok,
  requestIdOf,
} from "@/lib/crm-b2b/route-helpers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/whatsapp-campaigns/:id/recipients/:recipientId/resolve-uncertain
 * manager+: assume_sent | retry_anyway
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; recipientId: string }> },
): Promise<Response> {
  const requestId = requestIdOf(req);
  const authz = await requireRole("manager", {
    requestId,
    resource: "whatsapp_campaigns",
  });
  if (!authz.ok) return authz.response;
  try {
    const { id, recipientId } = await ctx.params;
    const body = await req.json();
    const supabase = await createClient();
    const data = await resolveUncertainRecipientHandler(
      supabase,
      ctxFromAuthz(authz, requestId),
      authz.user.id,
      id,
      recipientId,
      body,
    );
    return ok(data, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}
