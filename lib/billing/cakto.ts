import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { subscriptionPlan, type SubscriptionPlanId } from "./plans";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const money = z
  .union([z.number().nonnegative(), z.string().regex(/^\d+(?:\.\d{1,2})?$/)])
  .transform(Number);
const mapping = z.object({ offer: id, checkout: id });
const configSchema = z.object({
  product: z.uuid(),
  essencial: mapping,
  crescer: mapping,
  escala: mapping,
});
export function caktoConfiguration() {
  const clientId = process.env.CAKTO_CLIENT_ID?.trim();
  const clientSecret = process.env.CAKTO_CLIENT_SECRET?.trim();
  const webhookSecret = process.env.CAKTO_WEBHOOK_SECRET?.trim();
  const origin = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "");
  const catalog = configSchema.parse(JSON.parse(process.env.CAKTO_CATALOG || "{}"));
  if (
    !clientId ||
    !clientSecret ||
    !webhookSecret ||
    (origin.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(origin.hostname)) ||
    new Set([catalog.essencial.offer, catalog.crescer.offer, catalog.escala.offer]).size !== 3
  )
    throw new Error("Integração Cakto indisponível.");
  return { clientId, clientSecret, webhookSecret, origin: origin.origin, catalog };
}
export function verifyCaktoSignature(
  body: string,
  timestamp: string,
  signature: string,
  secret: string,
  now = Date.now(),
) {
  if (
    !secret ||
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    !/^v1=[a-f0-9]{64}$/i.test(signature)
  )
    return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(3), "hex"));
}

/** Token stays in this server process; credentials and response bodies are never logged. */
let cached: { key: string; token: string; until: number } | undefined;
let pending: { key: string; promise: Promise<string> } | undefined;
async function accessToken() {
  const { clientId, clientSecret } = caktoConfiguration();
  const key = clientId + ":" + clientSecret;
  if (cached?.key === key && cached.until > Date.now()) return cached.token;
  if (pending?.key === key) return pending.promise;
  const promise = (async () => {
    const response = await fetch("https://api.cakto.com.br/public_api/token/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "escreve-ai-billing/1.0",
      },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret }),
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new Error("Cakto: autenticação indisponível.");
    const data = z
      .object({
        access_token: z.string().min(1),
        expires_in: z.number().int().positive(),
        scope: z.string(),
      })
      .parse(await response.json());
    const scopes = new Set(data.scope.split(" "));
    if (!["read", "products", "offers", "orders", "subscriptions"].every((s) => scopes.has(s)))
      throw new Error("Cakto: permissões incompletas.");
    cached = {
      key,
      token: data.access_token,
      until: Date.now() + Math.max(0, data.expires_in - 60) * 1000,
    };
    return data.access_token;
  })();
  pending = { key, promise };
  try {
    return await promise;
  } finally {
    if (pending?.promise === promise) pending = undefined;
  }
}
export async function caktoGet(
  resource: "orders" | "subscriptions" | "offers",
  providerId: string,
) {
  id.parse(providerId);
  const token = await accessToken();
  const response = await fetch(
    `https://api.cakto.com.br/public_api/${resource}/${encodeURIComponent(providerId)}/`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "escreve-ai-billing/1.0",
      },
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
      redirect: "error",
    },
  );
  if (response.status === 401) cached = undefined;
  if (!response.ok) throw new Error("Cakto: consulta indisponível.");
  return response.json() as Promise<unknown>;
}
export const caktoOfferSchema = z.object({
  id,
  product: z.uuid(),
  price: money,
  currency: z.literal("BRL"),
  type: z.literal("subscription"),
  status: z.literal("active"),
  units: z.literal(1),
  recurrence_period: z.literal(30),
  quantity_recurrences: z.literal(-1),
  trial_days: z.literal(0),
});
export async function verifyCaktoOffer(planId: SubscriptionPlanId) {
  const config = caktoConfiguration();
  const offer = caktoOfferSchema.parse(await caktoGet("offers", config.catalog[planId].offer));
  if (
    offer.id !== config.catalog[planId].offer ||
    offer.product !== config.catalog.product ||
    Math.round(offer.price * 100) !== subscriptionPlan(planId)!.monthly_price_cents
  )
    throw new Error("Cakto: oferta divergente do catálogo.");
  return offer;
}
export function caktoCheckoutUrl(planId: SubscriptionPlanId, attemptId: string) {
  z.uuid().parse(attemptId);
  const config = caktoConfiguration();
  const url = new URL(`https://pay.cakto.com.br/${config.catalog[planId].checkout}`);
  // Random correlation ID, not a credential or a tenant-supplied organization ID.
  url.searchParams.set("sck", `escreve_${attemptId}`);
  return url.toString();
}
export const caktoOrderSchema = z.object({
  id: z.uuid(),
  status: z.string(),
  type: z.literal("subscription"),
  product: z.object({ id: z.uuid() }),
  subscription: z.union([z.uuid(), z.object({ id: z.uuid() })]),
  subscription_period: z.number().int().positive().nullable(),
  baseAmount: money,
  paidAt: z.iso.datetime({ offset: true }).nullable(),
  sck: z.string().nullable(),
});
export const caktoSubscriptionSchema = z.object({
  id: z.uuid(),
  product: z.uuid(),
  offer: id,
  customer: z.union([id, z.number().int().positive().transform(String)]),
  parent_order: z.uuid(),
  orders: z.array(z.uuid()).max(500),
  status: z.enum(["active", "inactive", "canceled", "expired", "paused", "late", "trial"]),
  amount: money,
  current_period: z.number().int().positive(),
  recurrence_period: z.literal(30),
  trial_days: z.literal(0),
  next_payment_date: z.iso.datetime({ offset: true }).nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export function caktoSubscriptionId(order: z.infer<typeof caktoOrderSchema>) {
  return typeof order.subscription === "string" ? order.subscription : order.subscription.id;
}
export function caktoAttempt(sck: string | null) {
  const value = sck?.startsWith("escreve_") ? sck.slice(8) : "";
  return z.uuid().safeParse(value).success ? value : null;
}
