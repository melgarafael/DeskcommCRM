import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { subscriptionPlan, type SubscriptionPlanId } from "./plans";

export class BillingUnavailable extends Error {
  constructor() {
    super("A cobrança ainda não está disponível nesta instalação.");
  }
}

export function billingConfiguration() {
  if (process.env.BILLING_ENABLED !== "true") throw new BillingUnavailable();
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  const webhook = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  const origin = process.env.NEXT_PUBLIC_APP_URL;
  const portalConfiguration = process.env.STRIPE_PORTAL_CONFIGURATION?.trim();
  if (!portalConfiguration || !/^bpc_[a-zA-Z0-9]+$/.test(portalConfiguration))
    throw new BillingUnavailable();
  if (!key || !/^sk_(test|live)_/.test(key) || !webhook || !origin) throw new BillingUnavailable();
  const url = new URL(origin);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname))
    throw new BillingUnavailable();
  return {
    key,
    webhook,
    origin: url.origin,
    portalConfiguration,
    live: key.startsWith("sk_live_"),
  };
}

export function verifyStripeSignature(
  body: string,
  signature: string,
  secret: string,
  now = Date.now(),
) {
  const parts = signature.split(",").map((part) => part.trim().split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300)
    return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  return parts.some(
    ([key, value]) =>
      key === "v1" &&
      typeof value === "string" &&
      /^[a-f0-9]{64}$/i.test(value) &&
      timingSafeEqual(expected, Buffer.from(value, "hex")),
  );
}

export function checkoutParameters(input: {
  organizationId: string;
  planId: SubscriptionPlanId;
  origin: string;
  attemptId: string;
  customerId?: string;
}) {
  const plan = subscriptionPlan(input.planId);
  if (!plan) throw new Error("Plano inválido.");
  const params = new URLSearchParams({
    mode: "subscription",
    client_reference_id: input.organizationId,
    success_url: `${input.origin}/app/settings/billing?checkout=returned`,
    cancel_url: `${input.origin}/app/settings/billing?checkout=canceled`,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "brl",
    "line_items[0][price_data][unit_amount]": String(plan.monthly_price_cents),
    "line_items[0][price_data][recurring][interval]": "month",
    "line_items[0][price_data][product_data][name]": `escreve.ai — ${plan.name}`,
    "subscription_data[metadata][organization_id]": input.organizationId,
    "subscription_data[metadata][plan_id]": plan.id,
    "metadata[organization_id]": input.organizationId,
    "metadata[plan_id]": plan.id,
    "metadata[checkout_attempt_id]": input.attemptId,
    "subscription_data[metadata][checkout_attempt_id]": input.attemptId,
  });
  if (input.customerId) params.set("customer", input.customerId);
  return params;
}

const checkoutSchema = z.object({
  id: z.string().startsWith("cs_"),
  url: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com";
  }),
  expires_at: z.number().int().positive(),
});

export async function createStripeCheckout(input: {
  organizationId: string;
  planId: SubscriptionPlanId;
  customerId?: string;
  attemptId: string;
}) {
  const config = billingConfiguration();
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": `escreve:${input.organizationId}:${input.attemptId}`,
    },
    body: checkoutParameters({ ...input, origin: config.origin }),
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Não foi possível abrir o pagamento. Tente novamente.");
  return checkoutSchema.parse(await response.json());
}

/** Reconcile the persisted attempt before its local expiry can allow a new checkout. */
export async function retrieveStripeCheckout(input: {
  sessionId: string;
  organizationId: string;
  attemptId: string;
  planId: string;
  customerId?: string;
}) {
  if (!/^cs_[a-zA-Z0-9_]+$/.test(input.sessionId)) throw new Error("Pagamento inválido.");
  const config = billingConfiguration();
  const response = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(input.sessionId)}`,
    {
      headers: { Authorization: `Bearer ${config.key}`, "Stripe-Version": "2025-06-30.basil" },
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    },
  );
  if (!response.ok) throw new Error("Não foi possível consultar o pagamento.");
  const session = z
    .object({
      id: z.literal(input.sessionId),
      mode: z.literal("subscription"),
      livemode: z.literal(config.live),
      client_reference_id: z.literal(input.organizationId),
      metadata: z.object({
        organization_id: z.literal(input.organizationId),
        checkout_attempt_id: z.literal(input.attemptId),
        plan_id: z.literal(input.planId),
      }),
      status: z.enum(["open", "complete", "expired"]),
      subscription: z
        .string()
        .regex(/^sub_[a-zA-Z0-9]+$/)
        .nullable(),
      customer: z
        .string()
        .regex(/^cus_[a-zA-Z0-9]+$/)
        .nullable(),
      expires_at: z.number().int().positive(),
      url: checkoutSchema.shape.url.nullable(),
    })
    .parse(await response.json());
  if (input.customerId && session.customer !== input.customerId)
    throw new Error("Pagamento divergente da empresa.");
  // An expired session cannot authorize a retry if it already created a subscription.
  if (session.status === "expired" && session.subscription)
    throw new Error("Pagamento com assinatura precisa ser conferido.");
  if (session.status === "open" && (!session.url || session.subscription))
    throw new Error("Pagamento aberto inconsistente.");
  return session;
}

export const stripeSubscriptionSchema = z.object({
  id: z.string().startsWith("sub_"),
  customer: z.string().startsWith("cus_"),
  livemode: z.boolean(),
  status: z.enum([
    "trialing",
    "active",
    "past_due",
    "canceled",
    "unpaid",
    "incomplete",
    "incomplete_expired",
    "paused",
  ]),
  cancel_at_period_end: z.boolean(),
  metadata: z.object({
    organization_id: z.uuid(),
    plan_id: z.string(),
    checkout_attempt_id: z.uuid(),
  }),
  items: z.object({
    data: z
      .array(
        z.object({
          current_period_start: z.number().int().positive(),
          current_period_end: z.number().int().positive(),
          quantity: z.number(),
          price: z.object({
            currency: z.string(),
            unit_amount: z.number().nullable(),
            recurring: z.object({ interval: z.string(), interval_count: z.number() }).nullable(),
          }),
        }),
      )
      .length(1),
  }),
});

export async function retrieveStripeSubscription(id: string) {
  if (!/^sub_[a-zA-Z0-9]+$/.test(id)) throw new Error("Assinatura inválida.");
  const config = billingConfiguration();
  const response = await fetch(
    `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(id)}`,
    {
      headers: { Authorization: `Bearer ${config.key}`, "Stripe-Version": "2025-06-30.basil" },
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    },
  );
  if (!response.ok) throw new Error("Não foi possível consultar a assinatura.");
  const subscription = stripeSubscriptionSchema.parse(await response.json());
  const plan = subscriptionPlan(subscription.metadata.plan_id);
  const item = subscription.items.data[0]!;
  if (
    !plan ||
    item.current_period_start >= item.current_period_end ||
    subscription.id !== id ||
    subscription.livemode !== config.live ||
    item.quantity !== 1 ||
    item.price.currency !== "brl" ||
    item.price.unit_amount !== plan.monthly_price_cents ||
    item.price.recurring?.interval !== "month" ||
    item.price.recurring.interval_count !== 1
  ) {
    throw new Error("Assinatura divergente do catálogo.");
  }
  return subscription;
}

/** A dedicated portal configuration must be reviewed before opening billing management. */
export async function createStripePortal(customerId: string) {
  const config = billingConfiguration();
  const portalConfiguration = config.portalConfiguration;
  if (
    !/^cus_[a-zA-Z0-9]+$/.test(customerId) ||
    !portalConfiguration ||
    !/^bpc_[a-zA-Z0-9]+$/.test(portalConfiguration)
  )
    throw new BillingUnavailable();
  const response = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2025-06-30.basil",
    },
    body: new URLSearchParams({
      customer: customerId,
      configuration: portalConfiguration,
      return_url: `${config.origin}/app/settings/billing`,
    }),
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Não foi possível abrir a gestão da assinatura.");
  const session = z
    .object({
      id: z.string().startsWith("bps_"),
      customer: z.literal(customerId),
      livemode: z.literal(config.live),
      url: z.url().refine((value) => new URL(value).origin === "https://billing.stripe.com"),
    })
    .parse(await response.json());
  return { url: session.url };
}
