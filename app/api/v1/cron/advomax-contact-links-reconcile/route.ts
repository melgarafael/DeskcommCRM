/** POST /api/v1/cron/advomax-contact-links-reconcile — confirma vínculos pending. */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { advomaxFileCode } from "@/lib/crm/document-intake";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;

type PendingLink = {
  id: string;
  organization_id: string;
  pessoa_codigo: number;
  created_by: string | null;
  created_by_email: string | null;
};

export async function GET(req: NextRequest): Promise<Response> { return run(req); }
export async function POST(req: NextRequest): Promise<Response> { return run(req); }

async function run(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!validCronSecret(req)) return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  if (!env.ADVOMAX_API_URL.trim() || !env.ADVOMAX_CRM_INTEGRATION_KEY.trim()) {
    return ok({ processed: 0, skipped: "bridge_not_configured" }, { requestId });
  }

  const parsedLimit = Number.parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  const admin = createAdminClient();
  const { data, error } = await admin.from("advomax_contact_links" as never)
    .select("id,organization_id,pessoa_codigo,created_by,created_by_email")
    .eq("status", "pending")
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) return fail("internal_error", "Não foi possível ler os vínculos pendentes.", 500, { requestId });

  const stats = { processed: 0, linked: 0, skipped_identity: 0, unchanged: 0, failed: 0 };
  for (const row of (data ?? []) as unknown as PendingLink[]) {
    stats.processed++;
    const email = row.created_by_email?.trim();
    if (!email) { stats.skipped_identity++; continue; }

    const base = env.ADVOMAX_API_URL.replace(/\/$/, "");
    const response = await fetch(`${base}/integracoes/crm/pessoas/${row.pessoa_codigo}/resumo`, {
      headers: {
        "X-CRM-Integration-Key": env.ADVOMAX_CRM_INTEGRATION_KEY,
        "X-CRM-User-Email": email,
        "X-CRM-Organization-Id": row.organization_id,
      },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!response?.ok) { stats.failed++; continue; }

    const body = await response.json().catch(() => null);
    const codigo = advomaxFileCode(body);
    if (codigo !== row.pessoa_codigo) { stats.failed++; continue; }

    const { data: updated, error: updateError } = await admin.from("advomax_contact_links" as never)
      .update({ status: "linked", last_synced_at: new Date().toISOString() } as never)
      .eq("id", row.id).eq("organization_id", row.organization_id).eq("status", "pending")
      .select("id").maybeSingle();
    if (updateError) { stats.failed++; continue; }
    if (!updated) { stats.unchanged++; continue; }
    stats.linked++;
    await audit({
      action: "contact.advomax_link_reconciled",
      actorUserId: row.created_by,
      organizationId: row.organization_id,
      resourceType: "advomax_contact_link",
      resourceId: row.id,
      requestId,
      metadata: { pessoa_codigo: row.pessoa_codigo },
    });
  }
  return ok(stats, { requestId });
}

function validCronSecret(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return Boolean(provided && [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].some((secret) => secret && secret === provided));
}
