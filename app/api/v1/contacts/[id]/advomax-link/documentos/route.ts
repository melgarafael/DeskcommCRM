/** GET /api/v1/contacts/[id]/advomax-link/documentos. */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { fail, ok } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
interface RouteCtx { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "advomax_document_summary" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;
  const supabase = await createClient();
  const { data: link, error: linkError } = await supabase
    .from("advomax_contact_links" as never)
    .select("pessoa_codigo,status")
    .eq("organization_id", authz.org.orgId)
    .eq("contact_id", id)
    .maybeSingle();
  if (linkError) return fail("internal_error", "Não foi possível consultar o vínculo.", 500, { requestId });
  const typedLink = link as { pessoa_codigo: number; status: string } | null;
  if (!typedLink || typedLink.status !== "linked") {
    return fail("conflict", "Vincule o cadastro jurídico antes de consultar documentos.", 409, { requestId });
  }
  if (!env.ADVOMAX_API_URL.trim() || !env.ADVOMAX_CRM_INTEGRATION_KEY.trim()) {
    return fail("integration_unavailable", "A integração com o Advomax não está configurada.", 503, { requestId });
  }
  const base = env.ADVOMAX_API_URL.replace(/\/$/, "");
  const response = await fetch(`${base}/integracoes/crm/pessoas/${typedLink.pessoa_codigo}/documentos`, {
    headers: {
      "X-CRM-Integration-Key": env.ADVOMAX_CRM_INTEGRATION_KEY,
      "X-CRM-User-Email": authz.user.email,
      "X-CRM-Organization-Id": authz.org.orgId,
    },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response?.ok) return fail("bad_gateway", "Não foi possível consultar os documentos no Advomax.", 502, { requestId });
  const body = await response.json().catch(() => null);
  if (!Array.isArray(body)) return fail("bad_gateway", "O Advomax devolveu documentos inválidos.", 502, { requestId });
  return ok(body, { requestId });
}
