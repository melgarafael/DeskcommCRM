import { createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  billingConfiguration,
  checkoutParameters,
  verifyStripeSignature,
} from "@/lib/billing/stripe";
afterEach(() => vi.unstubAllEnvs());
it("validates signatures over original bytes, timestamp and rotating secrets", () => {
  const body = '{"id":"evt_test"}';
  const timestamp = 1800000000;
  const secret = "test-signing-secret";
  const hash = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  expect(verifyStripeSignature(body, `t=${timestamp},v1=${hash}`, secret, timestamp * 1000)).toBe(
    true,
  );
  expect(
    verifyStripeSignature(body + " ", `t=${timestamp},v1=${hash}`, secret, timestamp * 1000),
  ).toBe(false);
  expect(
    verifyStripeSignature(body, `t=${timestamp},v1=${hash}`, secret, (timestamp + 301) * 1000),
  ).toBe(false);
  expect(
    verifyStripeSignature(body, `t=${timestamp},v1=bad,v1=${hash}`, secret, timestamp * 1000),
  ).toBe(true);
});
it("builds monthly price from catalogue and binds tenant in both metadata locations", () => {
  const params = checkoutParameters({
    organizationId: "org-a",
    attemptId: "11111111-1111-4111-8111-111111111111",
    planId: "crescer",
    origin: "https://crm.example.test",
  });
  expect(params.get("line_items[0][price_data][unit_amount]")).toBe("39700");
  expect(params.get("line_items[0][price_data][currency]")).toBe("brl");
  expect(params.get("subscription_data[metadata][organization_id]")).toBe("org-a");
  expect(params.get("metadata[organization_id]")).toBe("org-a");
  expect(params.get("metadata[checkout_attempt_id]")).toBe("11111111-1111-4111-8111-111111111111");
  expect(params.get("subscription_data[metadata][checkout_attempt_id]")).toBe(
    "11111111-1111-4111-8111-111111111111",
  );
  expect(params.get("success_url")).not.toContain("active");
});
it("fails closed when payment configuration is missing", () => {
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  expect(() => billingConfiguration()).toThrow("ainda não está disponível");
});

import { createStripePortal } from "@/lib/billing/stripe";
function portalEnv() {
  vi.stubEnv("BILLING_ENABLED", "true");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fixture");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_fixture");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example.test");
  vi.stubEnv("STRIPE_PORTAL_CONFIGURATION", "bpc_reviewed");
}
afterEach(() => vi.unstubAllGlobals());
it("opens only the server-selected portal customer and reviewed configuration", async () => {
  portalEnv();
  const fetchMock = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "bps_test",
        customer: "cus_own",
        livemode: false,
        url: "https://billing.stripe.com/p/session",
      }),
    });
  vi.stubGlobal("fetch", fetchMock);
  expect(await createStripePortal("cus_own")).toEqual({
    url: "https://billing.stripe.com/p/session",
  });
  const body = fetchMock.mock.calls[0]![1].body as URLSearchParams;
  expect(body.get("customer")).toBe("cus_own");
  expect(body.get("configuration")).toBe("bpc_reviewed");
  expect(body.get("return_url")).toBe("https://crm.example.test/app/settings/billing");
});
it.each([
  { customer: "cus_other", livemode: false, url: "https://billing.stripe.com/p/session" },
  { customer: "cus_own", livemode: true, url: "https://billing.stripe.com/p/session" },
  { customer: "cus_own", livemode: false, url: "https://evil.example/p/session" },
])("rejects a divergent portal response", async (data) => {
  portalEnv();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "bps_test", ...data }) }),
  );
  await expect(createStripePortal("cus_own")).rejects.toThrow();
});
it("does not contact the provider without a reviewed portal configuration", async () => {
  portalEnv();
  vi.stubEnv("STRIPE_PORTAL_CONFIGURATION", "");
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(createStripePortal("cus_own")).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});
