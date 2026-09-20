import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isSubscriptionResourceLimit,
  subscriptionResourceLimitResponse,
} from "@/lib/billing/resource-limit";
import { connectWahaChannel } from "@/lib/channels/connect-waha";

describe("subscription limit recovery", () => {
  it.each([
    null,
    undefined,
    "P4020",
    { code: "23505", message: "P4020" },
    { message: "Seu plano atingiu o limite de canais" },
  ])("does not disguise other failures as quota: %j", (error) => {
    expect(isSubscriptionResourceLimit(error)).toBe(false);
  });
  it("recognizes the database contract and returns a safe, localized next step", async () => {
    expect(isSubscriptionResourceLimit({ code: "P4020", message: "internal SQL detail" })).toBe(
      true,
    );
    const response = subscriptionResourceLimitResponse("request-test", "es");
    expect(response.status).toBe(409);
    expect(response.headers.get("X-Request-Id")).toBe("request-test");
    const body = await response.json();
    expect(body.error.code).toBe("subscription_resource_limit");
    expect(body.error.message).toContain("administrador");
    expect(body.error.message).toContain("conservado");
    expect(body.error.message).not.toContain("internal SQL");
    expect(body.error.details.billing_path).toBe("/app/settings/billing");
  });
  it("blocks channel setup before any external connection is created or stopped", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ error: { code: "P4020", message: "SQL details" }, data: null });
    const db = { rpc } as unknown as SupabaseClient;
    const transport = {
      createSession: vi.fn(),
      startExistingSession: vi.fn(),
      stopSession: vi.fn(),
    };
    await expect(
      connectWahaChannel(db, db, transport, {
        organizationId: "00000000-0000-4000-8000-000000000001",
        idempotencyKey: "00000000-0000-4000-8000-000000000002",
        userId: "00000000-0000-4000-8000-000000000003",
        requestId: "request-test",
        onboarding: true,
        restart: true,
      }),
    ).rejects.toMatchObject({ code: "subscription_resource_limit", status: 409 });
    expect(transport.createSession).not.toHaveBeenCalled();
    expect(transport.stopSession).not.toHaveBeenCalled();
    expect(transport.startExistingSession).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
