import { createHmac } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ connect: mocks.connect }),
}));
import { POST } from "@/app/api/v1/webhooks/cakto-billing/route";
const product = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  orderId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
beforeEach(() => {
  vi.resetAllMocks();
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
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
});
afterEach(() => vi.unstubAllEnvs());
function request(data: unknown, valid = true) {
  const body = JSON.stringify(data),
    timestamp = String(Math.floor(Date.now() / 1000));
  const signature =
    "v1=" + createHmac("sha256", "test").update(`${timestamp}.${body}`).digest("hex");
  return new Request("https://crm.example.test/api/v1/webhooks/cakto-billing", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cakto-timestamp": timestamp,
      "x-cakto-signature": valid ? signature : "v1=bad",
    },
    body,
  });
}
it("rejects unsigned messages before touching the database", async () => {
  expect(
    (
      await POST(
        request(
          { event: "purchase_approved", data: { id: orderId, product: { id: product } } },
          false,
        ),
      )
    ).status,
  ).toBe(401);
  expect(mocks.connect).not.toHaveBeenCalled();
});
it.each([false, true])(
  "queues V1/V2 delivery without secrets or customer data (V2=%s)",
  async (v2) => {
    const data = {
      id: orderId,
      product: { id: product },
      customer: { email: "synthetic@example.test" },
    };
    expect(
      (
        await POST(
          request({ secret: "never-store", event: "purchase_approved", data: v2 ? [data] : data }),
        )
      ).status,
    ).toBe(200);
    const writes = mocks.query.mock.calls.filter(([s]) => String(s).startsWith("insert"));
    expect(writes).toHaveLength(1);
    expect(writes[0]![1]).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
      orderId,
      "purchase_approved",
    ]);
    expect(JSON.stringify(mocks.query.mock.calls)).not.toMatch(/synthetic|never-store/);
  },
);
it("never acknowledges a failed database commit as successful", async () => {
  mocks.query.mockImplementation(async (s: string) => {
    if (s === "commit") throw new Error("offline");
    return { rows: [] };
  });
  expect(
    (
      await POST(
        request({ event: "purchase_approved", data: { id: orderId, product: { id: product } } }),
      )
    ).status,
  ).toBe(503);
  expect(mocks.query).toHaveBeenCalledWith("rollback");
  expect(mocks.release).toHaveBeenCalled();
});
it("ignores unrelated products and nonpayment events", async () => {
  expect((await POST(request({ event: "checkout_abandonment", data: {} }))).status).toBe(200);
  expect(
    (
      await POST(
        request({ event: "purchase_approved", data: { id: orderId, product: { id: orderId } } }),
      )
    ).status,
  ).toBe(200);
  expect(mocks.connect).not.toHaveBeenCalled();
});
