import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ fetch: vi.fn(), health: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async () => "provider-key",
  encryptWebhookSecret: async () => "enc",
}));
vi.mock("@/lib/channels/health", () => ({ resolverSaudeDaConexaoRemovida: h.health }));
vi.mock("@/lib/logger", () => ({ logger: { warn: h.warn, info: vi.fn(), error: vi.fn() } }));
vi.mock("../zernio/credentials", () => ({ zernioBaseUrl: () => "https://zernio.test" }));
import { disconnectSocialAccount } from "./store";
import { SocialError } from "./client";

const org = "org-1";
const account = "a".repeat(24);
type Update = { patch: Record<string, unknown>; filters: Record<string, unknown> };
function fakeDb(channels: Record<string, unknown>[]) {
  const updates: Update[] = [];
  const db = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let patch: Record<string, unknown> | null = null;
      const q = {
        select: () => q,
        update: (p: Record<string, unknown>) => ((patch = p), q),
        eq: (k: string, v: unknown) => ((filters[k] = v), q),
        is: (k: string, v: unknown) => ((filters[k] = v), q),
        maybeSingle: async () => ({
          data: { profile_id: "p", credential_encrypted: "x" },
          error: null,
        }),
        then: (resolve: (r: unknown) => void) => {
          if (patch) updates.push({ patch, filters });
          resolve({ data: table === "channel_sessions" && !patch ? channels : null, error: null });
        },
      };
      return q;
    },
  };
  return { db: db as never, updates };
}
const channel = {
  id: "ch-1",
  zernio_account_id: account,
  status: "WORKING",
  metadata: { social_webhook_id: "wh-1" },
  updated_at: "2026-10-01T00:00:00Z",
};
function provider(responses: Record<string, number>) {
  h.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    const key = `${init.method} ${url.replace("https://zernio.test/v1/", "")}`;
    if (key.startsWith("GET accounts"))
      return new Response(
        JSON.stringify({
          accounts: [{ _id: account, platform: "instagram", isActive: true, profileId: "p" }],
        }),
      );
    return new Response("{}", { status: responses[key] ?? 200 });
  });
}
const deletes = () =>
  h.fetch.mock.calls
    .filter(([, init]) => init.method === "DELETE")
    .map(([url]) => String(url).replace("https://zernio.test/v1/", ""));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", h.fetch);
  h.health.mockResolvedValue("resolvido");
});

it("removes the webhook and the account, then archives the channel with a new URL token", async () => {
  provider({});
  const { db, updates } = fakeDb([channel]);
  expect(await disconnectSocialAccount(db, org, account, true)).toEqual({
    channel_id: "ch-1",
    account_removed: true,
    avisos_fechados: "resolvido",
  });
  expect(deletes()).toEqual(["webhooks/settings?webhookId=wh-1", `accounts/${account}`]);
  expect(updates).toHaveLength(1);
  expect(updates[0]?.filters).toEqual({ organization_id: org, id: "ch-1" });
  expect(updates[0]?.patch).toMatchObject({ status: "STOPPED", archived_at: expect.any(String) });
  expect(updates[0]?.patch.webhook_path_token).toMatch(/^[a-f0-9]{48}$/);
  expect(h.health).toHaveBeenCalledWith(db, {
    id: "ch-1",
    organization_id: org,
    status: "STOPPED",
  });
});

it("only stops the inbox when the account should stay linked", async () => {
  provider({});
  const { db, updates } = fakeDb([channel]);
  await disconnectSocialAccount(db, org, account, false);
  expect(deletes()).toEqual(["webhooks/settings?webhookId=wh-1"]);
  expect(updates).toHaveLength(1);
});

it("keeps the channel intact when the provider refuses, so the action can be retried", async () => {
  provider({ "DELETE webhooks/settings?webhookId=wh-1": 500 });
  const { db, updates } = fakeDb([channel]);
  await expect(disconnectSocialAccount(db, org, account, true)).rejects.toBeInstanceOf(SocialError);
  expect(updates).toHaveLength(0);
});

it("treats provider 404 as already removed, so a retry converges", async () => {
  provider({
    "DELETE webhooks/settings?webhookId=wh-1": 404,
    [`DELETE accounts/${account}`]: 404,
  });
  const { db, updates } = fakeDb([channel]);
  await disconnectSocialAccount(db, org, account, true);
  expect(updates).toHaveLength(1);
});

it("never deletes an account outside the configured profile", async () => {
  provider({});
  const { db, updates } = fakeDb([]);
  await expect(disconnectSocialAccount(db, org, "b".repeat(24), true)).rejects.toMatchObject({
    status: 404,
  });
  expect(deletes()).toEqual([]);
  expect(updates).toHaveLength(0);
});

it("archives a channel whose account left the profile without deleting that account", async () => {
  provider({});
  const gone = "b".repeat(24);
  const { db, updates } = fakeDb([{ ...channel, zernio_account_id: gone }]);
  expect(await disconnectSocialAccount(db, org, gone, true)).toEqual({
    channel_id: "ch-1",
    account_removed: false,
    avisos_fechados: "resolvido",
  });
  expect(deletes()).toEqual(["webhooks/settings?webhookId=wh-1"]);
  expect(updates).toHaveLength(1);
});

it("logs and reports a health-alert failure instead of swallowing it, without undoing the archive", async () => {
  provider({});
  h.health.mockRejectedValue(new Error("ler os avisos abertos: 500"));
  const { db, updates } = fakeDb([channel]);
  expect(await disconnectSocialAccount(db, org, account, false)).toMatchObject({
    channel_id: "ch-1",
    avisos_fechados: "falhou",
  });
  expect(updates).toHaveLength(1);
  expect(h.warn).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      channel_session_id: "ch-1",
      organization_id: org,
      erro: "ler os avisos abertos: 500",
    }),
  );
});
