import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  caktoAttempt,
  caktoCheckoutUrl,
  caktoConfiguration,
  verifyCaktoSignature,
  verifyCaktoOffer,
} from "@/lib/billing/cakto";
const product = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const attempt = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const catalog = {
  product,
  essencial: { offer: "essential", checkout: "essential_1" },
  crescer: { offer: "grow", checkout: "grow" },
  escala: { offer: "scale", checkout: "scale" },
};
beforeEach(() => {
  vi.stubEnv("CAKTO_CLIENT_ID", crypto.randomUUID());
  vi.stubEnv("CAKTO_CLIENT_SECRET", "test-only");
  vi.stubEnv("CAKTO_WEBHOOK_SECRET", "signing-test");
  vi.stubEnv("CAKTO_CATALOG", JSON.stringify(catalog));
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example.test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("authenticates exact original bytes and rejects tampering, stale, future, malformed and empty secrets", () => {
  const body = '{"event":"purchase_approved"}';
  const timestamp = "1800000000";
  const secret = "secret";
  const sig = "v1=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  expect(verifyCaktoSignature(body, timestamp, sig, secret, 1800000000000)).toBe(true);
  for (const [b, t, s, k, n] of [
    [body + " ", timestamp, sig, secret, 1800000000000],
    [body, timestamp, sig, secret, 1800000301000],
    [body, timestamp, sig, secret, 1799999699000],
    [body, timestamp, "v1=bad", secret, 1800000000000],
    [body, timestamp, sig, "", 1800000000000],
  ] as const)
    expect(verifyCaktoSignature(b, t, s, k, n)).toBe(false);
});
it("binds checkout with a random attempt; contains neither credentials nor tenant data", () => {
  const url = new URL(caktoCheckoutUrl("essencial", attempt));
  expect(url.origin).toBe("https://pay.cakto.com.br");
  expect(url.pathname).toBe("/essential_1");
  expect([...url.searchParams.keys()]).toEqual(["sck"]);
  expect(caktoAttempt(url.searchParams.get("sck"))).toBe(attempt);
  expect(caktoAttempt("escreve_invalid")).toBeNull();
  expect(caktoAttempt(attempt)).toBeNull();
});
it("rejects duplicate offers, invalid URLs and incomplete configuration", () => {
  vi.stubEnv("CAKTO_CATALOG", JSON.stringify({ ...catalog, crescer: catalog.essencial }));
  expect(() => caktoConfiguration()).toThrow();
  vi.stubEnv("CAKTO_CATALOG", JSON.stringify(catalog));
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://crm.example.test");
  expect(() => caktoConfiguration()).toThrow();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example.test");
  vi.stubEnv("CAKTO_CLIENT_SECRET", "");
  expect(() => caktoConfiguration()).toThrow();
});
const offer = {
  id: "essential",
  product,
  price: 197,
  currency: "BRL",
  type: "subscription",
  status: "active",
  units: 1,
  recurrence_period: 30,
  quantity_recurrences: -1,
  trial_days: 0,
};
it("verifies server catalogue and caches the token across offer lookups", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        access_token: "test",
        expires_in: 3600,
        scope: "read products offers orders subscriptions",
      }),
    )
    .mockImplementation(() => Promise.resolve(Response.json(offer)));
  vi.stubGlobal("fetch", fetch);
  await verifyCaktoOffer("essencial");
  await verifyCaktoOffer("essencial");
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(fetch.mock.calls[0]![1].redirect).toBe("error");
});
it.each([
  { price: 1 },
  { product: attempt },
  { recurrence_period: 7 },
  { trial_days: 3 },
  { units: 2 },
  { status: "inactive" },
  { id: "wrong" },
])("refuses provider catalogue drift %j", async (patch) => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "test",
          expires_in: 3600,
          scope: "read products offers orders subscriptions",
        }),
      )
      .mockResolvedValueOnce(Response.json({ ...offer, ...patch })),
  );
  await expect(verifyCaktoOffer("essencial")).rejects.toThrow();
});
it("rejects a token without subscription access", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({
          access_token: "test",
          expires_in: 3600,
          scope: "read offers products orders",
        }),
      ),
  );
  await expect(verifyCaktoOffer("essencial")).rejects.toThrow("permissões");
});
