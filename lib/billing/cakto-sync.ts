import type { Pool, PoolClient } from "pg";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { subscriptionPlan } from "./plans";
import {
  caktoGet,
  caktoOrderSchema,
  caktoSubscriptionSchema,
  caktoConfiguration,
  caktoAttempt,
  caktoSubscriptionId,
} from "./cakto";

interface Current {
  organization_id: string;
  provider: string;
  plan_id: string;
  checkout_attempt_id: string;
  provider_subscription_id: string | null;
  provider_customer_id: string | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  cakto_paid_order_id: string | null;
  cakto_paid_period: number | null;
}
export async function syncCaktoOrder(
  db: PoolClient,
  orderId: string,
  eventId: string,
  eventType: string,
) {
  const config = caktoConfiguration();
  const order = caktoOrderSchema.parse(await caktoGet("orders", orderId));
  if (order.id !== orderId || order.product.id !== config.catalog.product)
    throw new Error("catalog_mismatch");
  const subId = caktoSubscriptionId(order);
  const first = caktoSubscriptionSchema.parse(await caktoGet("subscriptions", subId));
  const parent =
    first.parent_order === order.id
      ? order
      : caktoOrderSchema.parse(await caktoGet("orders", first.parent_order));
  const attempt = caktoAttempt(parent.sck);
  if (
    parent.id !== first.parent_order ||
    parent.product.id !== config.catalog.product ||
    caktoSubscriptionId(parent) !== subId ||
    !attempt
  )
    throw new Error("unbound_payment");
  const {
    rows: [binding],
  } = await db.query<{ organization_id: string }>(
    "select organization_id from org_subscriptions where provider='cakto' and checkout_attempt_id=$1",
    [attempt],
  );
  if (!binding) throw new Error("unbound_payment");
  await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    `billing:${binding.organization_id}`,
  ]);
  const {
    rows: [current],
  } = await db.query<Current>(
    "select * from org_subscriptions where organization_id=$1 for update",
    [binding.organization_id],
  );
  if (!current || current.provider !== "cakto" || current.checkout_attempt_id !== attempt)
    throw new Error("binding_changed");
  // Fetch after the tenant lock: delayed webhook deliveries cannot roll state back.
  const sub = caktoSubscriptionSchema.parse(await caktoGet("subscriptions", subId));
  const plan = subscriptionPlan(current.plan_id);
  if (
    !plan ||
    sub.id !== subId ||
    sub.parent_order !== parent.id ||
    sub.product !== config.catalog.product ||
    sub.offer !== config.catalog[plan.id].offer ||
    Math.round(sub.amount * 100) !== plan.monthly_price_cents ||
    !sub.orders.includes(order.id)
  )
    throw new Error("subscription_mismatch");
  if (current.provider_subscription_id && current.provider_subscription_id !== subId)
    throw new Error("duplicate_subscription");
  if (current.provider_customer_id && current.provider_customer_id !== sub.customer)
    throw new Error("customer_mismatch");
  let start = current.current_period_start;
  let end = current.current_period_end;
  let paidOrder = current.cakto_paid_order_id;
  let period = current.cakto_paid_period ?? 0;
  // Freeze each paid period once. Repeated deliveries or provider retry dates
  // cannot manufacture a fresh allowance for the same payment.
  if (
    order.status === "paid" &&
    order.paidAt &&
    order.subscription_period === sub.current_period &&
    sub.current_period > period
  ) {
    if (Math.round(order.baseAmount * 100) !== plan.monthly_price_cents || !sub.next_payment_date)
      throw new Error("payment_mismatch");
    const nextEnd = new Date(sub.next_payment_date);
    const nextStart = new Date(nextEnd.getTime() - sub.recurrence_period * 86400000);
    const paidAt = new Date(order.paidAt);
    if (nextStart > paidAt || nextEnd <= paidAt || (end && nextEnd <= end))
      throw new Error("period_mismatch");
    start = nextStart;
    end = nextEnd;
    paidOrder = order.id;
    period = sub.current_period;
  }
  // Refresh the currently credited order even when another order triggered this
  // event. An old paid event must not undo a later refund of the current period.
  const credited =
    paidOrder && paidOrder !== order.id
      ? caktoOrderSchema.parse(await caktoGet("orders", paidOrder))
      : order;
  if (paidOrder && (credited.id !== paidOrder || caktoSubscriptionId(credited) !== subId))
    throw new Error("credited_order_mismatch");
  const revoked = Boolean(paidOrder) && credited.status !== "paid";
  const paid = Boolean(paidOrder && end && end.getTime() > Date.now());
  const canceled = sub.status === "canceled";
  const status = revoked
    ? "unpaid"
    : paid && ["active", "canceled", "late", "expired"].includes(sub.status)
      ? "active"
      : sub.status === "paused"
        ? "paused"
        : canceled || sub.status === "expired"
          ? "canceled"
          : sub.status === "late"
            ? "past_due"
            : "pending";
  await db.query(
    `update org_subscriptions set provider_subscription_id=$2,provider_customer_id=$3,status=$4,current_period_start=$5,current_period_end=$6,cancel_at_period_end=$7,cakto_paid_order_id=$8,cakto_paid_period=$9,updated_at=now() where organization_id=$1`,
    [
      current.organization_id,
      subId,
      sub.customer,
      status,
      start,
      end,
      canceled,
      paidOrder,
      period || null,
    ],
  );
  await db.query(
    "insert into billing_webhook_events(provider,event_id,organization_id,event_type) values('cakto',$1,$2,$3) on conflict do nothing",
    [eventId, current.organization_id, eventType],
  );
  return {
    organizationId: current.organization_id,
    subscriptionId: subId,
    status,
    planId: plan.id,
  };
}

export async function drainCaktoBilling(pool: Pool) {
  let processed = 0,
    failed = 0;
  for (let i = 0; i < 3; i++) {
    const db = await pool.connect();
    let job: { id: string; order_id: string; event_type: string } | undefined;
    try {
      await db.query("begin");
      ({
        rows: [job],
      } = await db.query(
        "select id,order_id,event_type from cakto_billing_inbox where processed_at is null and retry_at<=now() order by received_at for update skip locked limit 1",
      ));
      if (!job) {
        await db.query("commit");
        break;
      }
      const result = await syncCaktoOrder(db, job.order_id, job.id, job.event_type);
      await db.query(
        "update cakto_billing_inbox set processed_at=now(),last_error=null where id=$1",
        [job.id],
      );
      await db.query("commit");
      processed++;
      void audit({
        action: "billing.subscription_synced",
        organizationId: result.organizationId,
        resourceType: "org_subscriptions",
        resourceId: result.organizationId,
        bypassedRls: true,
        metadata: {
          provider: "cakto",
          event_id: job.id,
          subscription_id: result.subscriptionId,
          status: result.status,
          plan_id: result.planId,
        },
      });
    } catch {
      await db.query("rollback").catch(() => undefined);
      failed++;
      if (job)
        await db.query(
          "update cakto_billing_inbox set attempts=attempts+1,last_error='confirmation_failed',retry_at=now()+interval '5 minutes' where id=$1 and processed_at is null",
          [job.id],
        );
      logger.error("[billing] Cakto confirmation failed; retained for retry", {
        event_id: job?.id,
      });
    } finally {
      db.release();
    }
  }
  return { processed, failed };
}
