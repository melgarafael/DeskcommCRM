import { audit } from "@/lib/audit";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import {
  billingConfiguration,
  retrieveStripeSubscription,
  verifyStripeSignature,
} from "@/lib/billing/stripe";
const eventSchema = z.object({
  id: z.string(),
  type: z.string(),
  livemode: z.boolean(),
  data: z.object({
    object: z
      .object({ id: z.string(), subscription: z.string().nullable().optional() })
      .passthrough(),
  }),
});

export async function POST(request: Request) {
  let config;
  try {
    config = billingConfiguration();
  } catch {
    return fail("service_unavailable", "Cobrança indisponível.", 503);
  }
  const body = await request.text();
  if (
    body.length > 1_000_000 ||
    !verifyStripeSignature(body, request.headers.get("stripe-signature") ?? "", config.webhook)
  )
    return fail("unauthorized", "Assinatura inválida.", 401);
  const parsed = eventSchema.safeParse(
    (() => {
      try {
        return JSON.parse(body);
      } catch {
        return null;
      }
    })(),
  );
  if (!parsed.success || parsed.data.livemode !== config.live)
    return fail("invalid_request", "Evento inválido.", 400);
  const event = parsed.data;
  const subscriptionId = event.type.startsWith("customer.subscription.")
    ? event.data.object.id
    : event.type === "checkout.session.completed"
      ? event.data.object.subscription
      : null;
  if (!subscriptionId) return ok({ received: true, ignored: true });
  const db = await getRequestPool()
    .connect()
    .catch(() => null);
  if (!db)
    return fail(
      "service_unavailable",
      "Não foi possível acessar a cobrança. Tente novamente.",
      503,
    );
  try {
    await db.query("begin");
    // Serialize before fetching current provider state: delayed events cannot roll it back.
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `stripe:${subscriptionId}`,
    ]);
    const duplicate = await db.query(
      "select 1 from billing_webhook_events where provider='stripe' and event_id=$1",
      [event.id],
    );
    if (duplicate.rowCount) {
      await db.query("commit");
      return ok({ received: true });
    }
    const subscription = await retrieveStripeSubscription(subscriptionId);
    const organizationId = subscription.metadata.organization_id;
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `billing:${organizationId}`,
    ]);
    const {
      rows: [current],
    } = await db.query("select * from org_subscriptions where organization_id=$1 for update", [
      organizationId,
    ]);
    if (
      !current ||
      current.provider !== "stripe" ||
      (current.provider_customer_id && current.provider_customer_id !== subscription.customer)
    )
      throw new Error("Unbound subscription");
    // A new checkout rotates this persisted UUID. Even a canceled replacement
    // must never be overwritten by events from an earlier checkout.
    if (current.checkout_attempt_id !== subscription.metadata.checkout_attempt_id) {
      await db.query("rollback");
      return ok({ received: true, ignored: true });
    }
    if (current.plan_id !== subscription.metadata.plan_id)
      throw new Error("Subscription plan does not match checkout");
    // Ignore an old subscription once another subscription has replaced it.
    if (
      current.provider_subscription_id &&
      current.provider_subscription_id !== subscription.id &&
      !["canceled", "incomplete_expired"].includes(current.status)
    ) {
      await db.query("rollback");
      return ok({ received: true, ignored: true });
    }
    await db.query(
      `update org_subscriptions set plan_id=$2,provider_customer_id=$3,provider_subscription_id=$4,status=$5,current_period_end=to_timestamp($6),cancel_at_period_end=$7,updated_at=now() where organization_id=$1`,
      [
        organizationId,
        subscription.metadata.plan_id,
        subscription.customer,
        subscription.id,
        subscription.status,
        subscription.items.data[0]?.current_period_end ?? null,
        subscription.cancel_at_period_end,
      ],
    );
    await db.query(
      "insert into billing_webhook_events(provider,event_id,organization_id,event_type) values('stripe',$1,$2,$3)",
      [event.id, organizationId, event.type],
    );
    await db.query("commit");
    void audit({
      action: "billing.subscription_synced",
      organizationId,
      resourceType: "org_subscriptions",
      resourceId: organizationId,
      bypassedRls: true,
      metadata: {
        provider: "stripe",
        event_id: event.id,
        subscription_id: subscription.id,
        status: subscription.status,
        plan_id: subscription.metadata.plan_id,
      },
    });
    return ok({ received: true });
  } catch {
    await db.query("rollback").catch(() => undefined);
    return fail(
      "service_unavailable",
      "Não foi possível confirmar o evento. Tente novamente.",
      503,
    );
  } finally {
    db.release();
  }
}
