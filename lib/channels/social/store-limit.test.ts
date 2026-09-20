import type * as SocialClient from "./client";
import { expect, it, vi } from "vitest";
import { connectSocialInbox } from "./store";
import { socialRequest } from "./client";
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: vi.fn(async () => "key"),
  encryptWebhookSecret: vi.fn(async () => "encrypted"),
}));
vi.mock("./client", async (original) => ({
  ...(await original<typeof SocialClient>()),
  socialRequest: vi.fn(),
  listSocialAccounts: vi.fn(async () => [
    { _id: "account", platform: "instagram", isActive: true },
  ]),
}));
it("quota refusal precedes webhook creation and preserves the database error code", async () => {
  const db = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "is"]) chain[method] = () => chain;
      chain.maybeSingle = async () => ({
        data: { profile_id: "profile", credential_encrypted: "enc" },
        error: null,
      });
      chain.then = (resolve: (value: unknown) => void) => resolve({ data: [], error: null });
      chain.insert = () => ({
        select: () => ({
          single: async () => ({ data: null, error: { code: "P4020", message: "private" } }),
        }),
      });
      if (!["channel_integrations", "channel_sessions"].includes(table)) throw new Error(table);
      return chain;
    },
  };
  await expect(
    connectSocialInbox(db as never, "trusted", "account", "https://crm.test"),
  ).rejects.toMatchObject({ code: "P4020" });
  expect(socialRequest).not.toHaveBeenCalled();
});
