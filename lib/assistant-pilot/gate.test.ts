import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { assertPilotIdentity, pilotDomain } from "./domain";
import { pilotEnabled } from "./gate";
const PILOT_TENANT = "00000000-0000-4000-8000-000000000001",
  PILOT_USER = "00000000-0000-4000-8000-000000000002";
beforeEach(() => {
  vi.stubEnv("ASSISTANT_PILOT_ORGANIZATION_ID", PILOT_TENANT);
  vi.stubEnv("ASSISTANT_PILOT_OWNER_USER_ID", PILOT_USER);
});
const identity = { tenantId: PILOT_TENANT, userId: PILOT_USER, assistantId: "internal-assistant" };
afterEach(() => vi.unstubAllEnvs());
it("requires existing owner, tenant, assistant and exact enabled env", () => {
  vi.stubEnv("ASSISTANT_PILOT_ENABLED", "true");
  vi.stubEnv("ASSISTANT_PILOT_OWNER_USER_ID", PILOT_USER);
  expect(pilotEnabled(identity)).toBe(true);
  for (const field of ["tenantId", "userId", "assistantId"] as const) {
    expect(pilotEnabled({ ...identity, [field]: "other" })).toBe(false);
    expect(() => assertPilotIdentity({ ...identity, [field]: "other" })).toThrow(
      "pilot_identity_denied",
    );
  }
  vi.stubEnv("ASSISTANT_PILOT_ENABLED", "false");
  expect(pilotEnabled(identity)).toBe(false);
  vi.stubEnv("ASSISTANT_PILOT_ENABLED", "true");
  vi.stubEnv("ASSISTANT_PILOT_OWNER_USER_ID", "other");
  expect(pilotEnabled(identity)).toBe(false);
});
it("canonical read query uses trusted identity and bounded page; no model or mutation", async () => {
  const review = vi
    .fn()
    .mockResolvedValue({
      conversations: [
        { id: "fixture", last_inbound_at: null, last_outbound_at: null, secret: "excluded" },
      ],
      has_more: true,
      cursor: null,
    });
  const result = await pilotDomain(identity, { review }).review();
  expect(review).toHaveBeenCalledExactlyOnceWith(
    { organization_id: PILOT_TENANT, actor: { type: "user", id: PILOT_USER } },
    { limit: 20, exclude_finished: true },
  );
  expect(result).toEqual({
    conversations: [{ id: "fixture", last_inbound_at: null, last_outbound_at: null }],
    has_more: true,
    cursor: null,
  });
});

it("is off with absent allowlist and with an arbitrary identity", () => {
  vi.stubEnv("ASSISTANT_PILOT_ENABLED", "true");
  vi.stubEnv("ASSISTANT_PILOT_ORGANIZATION_ID", "");
  expect(pilotEnabled(identity)).toBe(false);
  vi.stubEnv("ASSISTANT_PILOT_ORGANIZATION_ID", PILOT_TENANT);
  vi.stubEnv("ASSISTANT_PILOT_OWNER_USER_ID", "");
  expect(pilotEnabled(identity)).toBe(false);
});
