import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncAmigo } from "@/lib/amigo/sync";
import { STATUS_OPERANTE, ehOperante } from "@/lib/organizacao/operante";
import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  if (!autorizaCron(req)) return fail("unauthorized", "Não autorizado.", 401, { requestId });
  const db = createAdminClient();
  const { data, error } = await db
    .from("amigo_connections")
    .select("organization_id,organizations!amigo_connections_organization_id_fkey!inner(status)")
    .eq("active", true)
    .eq("organizations.status", STATUS_OPERANTE)
    .or(`last_sync_at.is.null,last_sync_at.lt.${new Date(Date.now() - 240_000).toISOString()}`)
    .order("last_sync_at", { nullsFirst: true })
    .limit(1);
  if (error?.code === "42P01" || error?.code === "PGRST205")
    return ok({ examined: 0, failed: 0 }, { requestId });
  if (error)
    return fail("amigo_sync_failed", "Não foi possível consultar as integrações.", 503, {
      requestId,
    });
  let examined = 0,
    failed = 0;
  for (const row of data ?? []) {
    const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
    if (!ehOperante(org?.status)) continue;
    try {
      const result = await syncAmigo(row.organization_id, requestId);
      examined += result.examined;
      if (result.examined > 0 || result.reconciled > 0)
        await audit({
          action: "amigo.synced",
          organizationId: row.organization_id,
          requestId,
          metadata: { examined: result.examined, reconciled: result.reconciled },
        });
    } catch {
      failed++;
    }
  }
  return ok({ examined, failed }, { requestId });
}
export const GET = POST;
