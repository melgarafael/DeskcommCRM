import type * as Cakto from "@/lib/billing/cakto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/billing/cakto", async (importOriginal) => ({
  ...(await importOriginal<typeof Cakto>()),
  caktoGet: mocks.get,
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
import { syncCaktoOrder } from "@/lib/billing/cakto-sync";
const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  subId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  orderId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  attempt = "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  product = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
let current: Record<string, unknown>, order: Record<string, unknown>, sub: Record<string, unknown>;
beforeEach(() => {
  vi.stubEnv("CAKTO_CLIENT_ID", "test");
  vi.stubEnv("CAKTO_CLIENT_SECRET", "test");
  vi.stubEnv("CAKTO_WEBHOOK_SECRET", "test");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example.test");
  vi.stubEnv(
    "CAKTO_CATALOG",
    JSON.stringify({
      product,
      essencial: { offer: "e", checkout: "e" },
      crescer: { offer: "c", checkout: "c" },
      escala: { offer: "s", checkout: "s" },
    }),
  );
  current = {
    organization_id: org,
    provider: "cakto",
    plan_id: "essencial",
    checkout_attempt_id: attempt,
    provider_subscription_id: null,
    provider_customer_id: null,
    current_period_start: null,
    current_period_end: null,
    cakto_paid_order_id: null,
    cakto_paid_period: null,
  };
  order = {
    id: orderId,
    status: "paid",
    type: "subscription",
    product: { id: product },
    subscription: subId,
    subscription_period: 1,
    baseAmount: "197.00",
    paidAt: "2099-01-02T00:00:00Z",
    sck: `escreve_${attempt}`,
  };
  sub = {
    id: subId,
    product,
    offer: "e",
    customer: "buyer",
    parent_order: orderId,
    orders: [orderId],
    status: "active",
    amount: "197.00",
    current_period: 1,
    recurrence_period: 30,
    trial_days: 0,
    next_payment_date: "2099-02-01T00:00:00Z",
    updatedAt: "2099-01-02T00:00:00Z",
  };
  mocks.get
    .mockReset()
    .mockImplementation(async (resource: string) =>
      structuredClone(resource === "orders" ? order : sub),
    );
});
afterEach(() => vi.unstubAllEnvs());
function database() {
  return {
    query: vi.fn(async (sql: string) => ({
      rows: sql.startsWith("select organization_id")
        ? [{ organization_id: org }]
        : sql.startsWith("select *")
          ? [current]
          : [],
    })),
  };
}
function update(db: ReturnType<typeof database>) {
  return db.query.mock.calls.find(([sql]) =>
    sql.startsWith("update org_subscriptions"),
  ) as unknown as [string, unknown[]];
}
it("confirms server-owned attempt and price before updating only its tenant", async () => {
  const db = database();
  await syncCaktoOrder(db as unknown as PoolClient, orderId, "event", "purchase_approved");
  const [sql, args] = update(db);
  expect(sql).toContain("where organization_id=$1");
  expect(args[0]).toBe(org);
  expect(args[3]).toBe("active");
  expect(args[7]).toBe(orderId);
  expect(args[8]).toBe(1);
});
it.each(["sck", "price", "subscription", "customer"])("rejects mismatched %s", async (kind) => {
  if (kind === "sck") order.sck = "escreve_invalid";
  if (kind === "price") sub.amount = "1.00";
  if (kind === "subscription") current.provider_subscription_id = org;
  if (kind === "customer") current.provider_customer_id = "other";
  const db = database();
  await expect(
    syncCaktoOrder(db as unknown as PoolClient, orderId, "event", "purchase_approved"),
  ).rejects.toThrow();
  expect(update(db)).toBeUndefined();
});
it("a repeated payment does not shift an already credited period", async () => {
  const start = new Date("2099-01-02T00:00:00Z"),
    end = new Date("2099-02-01T00:00:00Z");
  Object.assign(current, {
    provider_subscription_id: subId,
    cakto_paid_order_id: orderId,
    cakto_paid_period: 1,
    current_period_start: start,
    current_period_end: end,
  });
  sub.next_payment_date = "2099-02-05T00:00:00Z";
  const db = database();
  await syncCaktoOrder(db as unknown as PoolClient, orderId, "repeat", "purchase_approved");
  const args = update(db)[1];
  expect(args[4]).toBe(start);
  expect(args[5]).toBe(end);
});
it("a generated or refused payment never grants an allowance", async () => {
  order.status = "waiting_payment";
  order.paidAt = null;
  const db = database();
  await syncCaktoOrder(db as unknown as PoolClient, orderId, "event", "purchase_refused");
  const args = update(db)[1];
  expect(args[3]).toBe("pending");
  expect(args[4]).toBeNull();
  expect(args[7]).toBeNull();
});
it("refund of the credited order revokes access even with a stale active subscription", async () => {
  Object.assign(current, {
    provider_subscription_id: subId,
    cakto_paid_order_id: orderId,
    cakto_paid_period: 1,
    current_period_start: new Date("2099-01-02T00:00:00Z"),
    current_period_end: new Date("2099-02-01T00:00:00Z"),
  });
  order.status = "refunded";
  const db = database();
  await syncCaktoOrder(db as unknown as PoolClient, orderId, "event", "refund");
  expect(update(db)[1][3]).toBe("unpaid");
});
it("cancellation preserves the already paid period and stops renewal flag", async () => {
  sub.status = "canceled";
  const db = database();
  await syncCaktoOrder(db as unknown as PoolClient, orderId, "event", "subscription_canceled");
  expect(update(db)[1][3]).toBe("active");
  expect(update(db)[1][6]).toBe(true);
});
