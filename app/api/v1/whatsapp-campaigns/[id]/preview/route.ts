import { type NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { previewCampaignHandler } from "@/lib/whatsapp-campaigns/handlers";
import { ctxFromAuthz, handleRouteError, ok, requestIdOf } from "@/lib/crm-b2b/route-helpers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = requestIdOf(req);
  const authz = await requireRole("manager", { requestId, resource: "whatsapp_campaigns" });
  if (!authz.ok) return authz.response;
  const { id } = await params;
  try {
    const supabase = await createClient();
    return ok(await previewCampaignHandler(supabase, ctxFromAuthz(authz, requestId), id), {
      requestId,
    });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}
