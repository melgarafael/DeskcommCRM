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
