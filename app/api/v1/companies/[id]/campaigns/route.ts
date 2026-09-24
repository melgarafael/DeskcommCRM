import { type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import {
  handleRouteError,
  ok,
  requestIdOf,
} from "@/lib/crm-b2b/route-helpers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/companies/:id/campaigns
 * Histórico leve de recipients da empresa em campanhas (sem N+1).
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = requestIdOf(req);
  const authz = await requireRole("viewer", { requestId, resource: "companies" });
  if (!authz.ok) return authz.response;
  try {
    const { id: companyId } = await ctx.params;
    const supabase = await createClient();
    const orgId = authz.org.orgId;

    const { data: company } = await supabase
      .from("companies")
      .select("id")
      .eq("organization_id", orgId)
      .eq("id", companyId)
      .maybeSingle();
    if (!company) {
      return Response.json(
        { error: { code: "not_found", message: "Empresa não encontrada." } },
        { status: 404, headers: { "X-Request-Id": requestId } },
      );
    }

    const { data, error } = await supabase
      .from("whatsapp_campaign_recipients")
      .select(
        "id, campaign_id, phone_number_snapshot, person_name_snapshot, status, sent_at, replied_at, created_at, whatsapp_campaigns(id, name)",
      )
      .eq("organization_id", orgId)
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      return Response.json(
        { error: { code: "internal_error", message: error.message } },
        { status: 500, headers: { "X-Request-Id": requestId } },
      );
    }

    const rows = (data ?? []).map((r) => {
      const raw = r.whatsapp_campaigns as unknown;
      const camp = Array.isArray(raw)
        ? (raw[0] as { id: string; name: string } | undefined)
        : (raw as { id: string; name: string } | null);
      return {
        recipient_id: r.id,
        campaign_id: r.campaign_id,
        campaign_name: camp?.name ?? null,
        person: r.person_name_snapshot,
        phone: r.phone_number_snapshot,
        status: r.status,
        sent_at: r.sent_at,
        replied_at: r.replied_at,
        created_at: r.created_at,
      };
    });

    return ok(rows, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}
