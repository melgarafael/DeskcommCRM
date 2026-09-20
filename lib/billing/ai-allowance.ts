import { randomUUID } from "node:crypto";
import type pg from "pg";

type Database = Pick<pg.Pool, "query">;
export class SubscriptionAiAllowanceError extends Error {
  readonly terminal = true;
  override readonly name = "subscription_ai_allowance";
  constructor() {
    super(
      "A franquia de IA está indisponível ou em conferência. Consulte Planos e assinatura para verificar seu saldo.",
    );
  }
}

/** Legacy companies remain unchanged; the database serializes paid reservations. */
export async function reserveSubscriptionAi(db: Database, organizationId: string) {
  const { rows } = await db.query<{ provider_subscription_id: string | null }>(
    "select provider_subscription_id from org_subscriptions where organization_id=$1",
    [organizationId],
  );
  if (!rows[0]?.provider_subscription_id) return null;
  const callId = randomUUID();
  try {
    const result = await db.query<{ reservation_id: string | null }>(
      "select fn_reserve_subscription_ai($1,$2) as reservation_id",
      [organizationId, callId],
    );
    if (!result.rows[0]) throw new Error("AI allowance reservation returned no result");
    return result.rows[0].reservation_id;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P4021")
      throw new SubscriptionAiAllowanceError();
    throw error;
  }
}

/** A failed reconciliation retains the hold; it must never fabricate a zero cost. */
export async function settleSubscriptionAi(
  db: Database,
  organizationId: string,
  reservationId: string | null,
  costUsdCents: number | null,
) {
  if (!reservationId) return;
  await db.query("select fn_settle_subscription_ai($1,$2,$3)", [
    organizationId,
    reservationId,
    costUsdCents,
  ]);
}
