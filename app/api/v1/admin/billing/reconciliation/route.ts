import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { fail, ok } from "@/lib/api/wrappers";
import { reconciliationSchema, type PendingAiUsage } from "@/lib/billing/reconciliation";
const querySchema = z.object({ after: z.string().uuid().optional() });
export async function GET(req: NextRequest) {
  let admin;
  try {
    admin = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Administração da plataforma necessária.", 403);
  }
  const query = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!query.success) return fail("validation_error", "Página inválida.", 400);
  try {
    // Platform-wide read: only the platform guard above grants this cross-tenant scope.
    const { rows } = await getRequestPool().query<PendingAiUsage>(
      "select r.id,r.organization_id,o.display_name as company,r.provider,r.model,r.created_at,r.reserved_brl_cents::text,p.usd_to_brl_rate::text,p.period_start,p.period_end,r.usage_evidence " +
        "from subscription_ai_reservations r join subscription_ai_periods p on p.id=r.period_id and p.organization_id=r.organization_id " +
        "join organizations o on o.id=r.organization_id where r.status='unknown' and ($1::uuid is null or r.id>$1::uuid) order by r.id limit 51",
      [query.data.after ?? null],
    );
    const items = rows.slice(0, 50);
    return ok({
      items,
      next_cursor: rows.length > 50 ? items.at(-1)!.id : null,
      can_resolve: admin.platformAdmin.scope === "full",
    });
  } catch {
    return fail("db_error", "Não foi possível carregar os consumos em conferência.", 503);
  }
}
export async function POST(req: NextRequest) {
  let admin;
  try {
    admin = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Administração da plataforma necessária.", 403);
  }
  if (admin.platformAdmin.scope !== "full")
    return fail("forbidden", "Seu acesso permite somente leitura.", 403);
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const body = reconciliationSchema.safeParse(await req.json().catch(() => null));
  if (!body.success)
    return fail(
      "validation_error",
      "Confira o custo, a referência e a confirmação da verificação.",
      400,
    );
  const db = getRequestPool();
  try {
    // Resolve organization from the stored resource, never from a client-supplied tenant.
    const { rows } = await db.query<{ organization_id: string }>(
      "select organization_id from subscription_ai_reservations where id=$1",
      [body.data.reservation_id],
    );
    const record = rows[0];
    if (!record) return fail("not_found", "Consumo não encontrado.", 404);
    const { rows: result } = await db.query<{ charged_brl_cents: string }>(
      "select fn_reconcile_subscription_ai($1,$2,$3,$4,$5,$6)::text as charged_brl_cents",
      [
        record.organization_id,
        body.data.reservation_id,
        admin.user.id,
        body.data.cost_usd_cents,
        body.data.reference,
        randomUUID(),
      ],
    );
    if (!result[0])
      return fail("db_error", "A confirmação não foi recebida. Atualize a lista.", 503);
    // The RPC writes the audit in the same transaction as settlement.
    return ok(result[0]);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P4022")
      return fail(
        "state_conflict",
        "O consumo mudou ou não tem identificação suficiente. Atualize a lista.",
        409,
      );
    if (error && typeof error === "object" && "code" in error && error.code === "42501")
      return fail("forbidden", "A permissão administrativa foi alterada.", 403);
    return fail(
      "db_error",
      "Não foi possível confirmar a conciliação. Atualize a lista antes de tentar novamente.",
      503,
    );
  }
}
