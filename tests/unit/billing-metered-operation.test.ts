import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ query: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: m.query }),
}));
vi.mock("@/lib/logger", () => ({ logger: { error: m.error } }));
import { measuredTextUsage, runMeteredOperation } from "@/lib/billing/metered-operation";
const identity = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  provider: "openai",
  model: "test-model",
};
const result = { text: "Resposta", usage: { inputTokens: 1000, outputTokens: 500 } };
beforeEach(() => {
  vi.clearAllMocks();
  m.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes("select provider_subscription_id"))
      return { rows: [{ provider_subscription_id: "sub_paid" }] };
    if (sql.includes("fn_reserve_subscription_ai"))
      return { rows: [{ reservation_id: params[1] }] };
    if (sql.includes("from ai_models"))
      return {
        rows: [{ input_price_per_million_cents: 100, output_price_per_million_cents: 200 }],
      };
    return { rows: [] };
  });
});
it("reserves before invoking the provider and settles measured cost for the same company", async () => {
  const call = vi.fn(async () => {
    expect(m.query.mock.calls.some(([sql]) => sql.includes("fn_reserve_subscription_ai"))).toBe(
      true,
    );
    return result;
  });
  expect(await runMeteredOperation(identity, call, (r) => measuredTextUsage(r.usage))).toBe(result);
  expect(m.query).toHaveBeenCalledWith("select fn_settle_subscription_ai($1,$2,$3)", [
    identity.organizationId,
    expect.any(String),
    0.2,
  ]);
});
it("quota rejection never invokes the provider", async () => {
  m.query.mockResolvedValueOnce({ rows: [{ provider_subscription_id: "sub_paid" }] });
  m.query.mockRejectedValueOnce(
    Object.assign(new Error("sensitive database detail"), { code: "P4021" }),
  );
  const call = vi.fn();
  await expect(runMeteredOperation(identity, call, () => null)).rejects.toMatchObject({
    name: "subscription_ai_allowance",
  });
  expect(call).not.toHaveBeenCalled();
});
it("legacy companies keep their result without commercial writes", async () => {
  m.query.mockResolvedValueOnce({ rows: [] });
  expect(
    await runMeteredOperation(
      identity,
      async () => result,
      () => null,
    ),
  ).toBe(result);
  expect(m.query).toHaveBeenCalledTimes(1);
});
it("provider failure holds unknown consumption and rethrows the original error", async () => {
  const original = new Error("provider failed");
  await expect(
    runMeteredOperation(
      identity,
      async () => {
        throw original;
      },
      () => null,
    ),
  ).rejects.toBe(original);
  expect(m.query).toHaveBeenCalledWith("select fn_settle_subscription_ai($1,$2,$3)", [
    identity.organizationId,
    expect.any(String),
    null,
  ]);
});
it("missing usage is unknown, not zero", async () => {
  expect(measuredTextUsage(undefined)).toBeNull();
  expect(measuredTextUsage({ inputTokens: 1 })).toBeNull();
  await runMeteredOperation(
    identity,
    async () => result,
    () => null,
  );
  expect(m.query).toHaveBeenCalledWith("select fn_settle_subscription_ai($1,$2,$3)", [
    identity.organizationId,
    expect.any(String),
    null,
  ]);
});
it("database failure in settlement preserves the answer and logs the reservation for reconciliation", async () => {
  const original = m.query.getMockImplementation()!;
  m.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes("fn_settle_subscription_ai")) throw new Error("database unavailable");
    return original(sql, params);
  });
  expect(
    await runMeteredOperation(
      identity,
      async () => result,
      (r) => measuredTextUsage(r.usage),
    ),
  ).toBe(result);
  expect(m.error).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      organization_id: identity.organizationId,
      reservation_id: expect.any(String),
    }),
  );
});
