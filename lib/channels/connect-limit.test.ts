import { expect, it, vi } from "vitest";
import { savePartnerSession } from "./connect";
it.each([null, "existing"])(
  "preserves the database quota code on insert/update (%s)",
  async (existingId) => {
    const error = { code: "P4020", message: "quota detail" };
    const chain = { eq: vi.fn(async () => ({ error })) };
    const db = {
      from: vi.fn(() => ({ insert: vi.fn(async () => ({ error })), update: vi.fn(() => chain) })),
    };
    expect(
      await savePartnerSession(db as never, {
        organizationId: "trusted",
        existingId,
        accountId: "account",
        apiKeyEncrypted: "encrypted",
        webhookPathToken: "token",
        webhookSecretEncrypted: "encrypted",
        phoneNumber: null,
        displayName: "Test",
      }),
    ).toEqual({ error: "quota detail", code: "P4020" });
  },
);
