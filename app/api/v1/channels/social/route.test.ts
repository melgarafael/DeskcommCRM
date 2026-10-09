import type * as SocialClient from "@/lib/channels/social/client";
import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  role: vi.fn(),
  mfa: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  configure: vi.fn(),
  read: vi.fn(),
  channels: vi.fn(),
  accounts: vi.fn(),
  limit: vi.fn(),
  disconnect: vi.fn(),
  unlink: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: h.mfa }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.support }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: h.limit }));
vi.mock("@/lib/channels/social/store", () => ({
  readSocialIntegration: h.read,
  configureSocialIntegration: h.configure,
  desvincularPerfilSocial: h.unlink,
  socialChannels: h.channels,
  connectSocialInbox: vi.fn(),
  disconnectSocialAccount: h.disconnect,
}));
vi.mock("@/lib/channels/social/client", async (original) => ({
  ...(await original<typeof SocialClient>()),
  listSocialAccounts: h.accounts,
}));
import { GET, POST } from "./route";
const call = (body: unknown) =>
  POST(new Request("https://crm.test/api", { method: "POST", body: JSON.stringify(body) }));
beforeEach(() => {
  vi.clearAllMocks();
  h.role.mockResolvedValue({ ok: true, org: { orgId: "trusted" }, user: { id: "admin" } });
  h.mfa.mockResolvedValue(false);
  h.support.mockResolvedValue(null);
  h.limit.mockResolvedValue({ allowed: true });
  h.read.mockResolvedValue({ key: "hidden-key", profileId: "profile" });
  h.channels.mockResolvedValue([]);
  h.accounts.mockResolvedValue([
    { _id: "account", platform: "instagram", username: "brand", isActive: true },
  ]);
});
it("requires admin and never returns the stored key", async () => {
  const response = await GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(JSON.stringify(await response.json())).not.toContain("hidden-key");
  expect(h.read).toHaveBeenCalledWith({}, "trusted");
  expect(h.role).toHaveBeenCalledWith("admin", expect.anything());
});
it("lists channels whose account left the profile as orphaned", async () => {
  h.channels.mockResolvedValue([
    {
      id: "ch-nova",
      updated_at: "2026-10-06T00:00:00Z",
      accountId: "account",
      display_name: "Instagram · brand",
      status: "WORKING",
      metadata: {},
    },
    {
      id: "ch-orfa",
      updated_at: "2026-10-06T00:00:00Z",
      accountId: "velha",
      display_name: "Instagram · velha",
      status: "FAILED",
      metadata: {},
    },
  ]);
  const body = (await (await GET()).json()) as {
    data: {
      accounts: { channel: { id: string } | null }[];
      orphaned_channels: {
        channel_id: string;
        account_id: string;
        display_name: string | null;
        status: string;
      }[];
    };
  };
  expect(body.data.orphaned_channels).toEqual([
    {
      channel_id: "ch-orfa",
      account_id: "velha",
      display_name: "Instagram · velha",
      status: "FAILED",
    },
  ]);
  expect(JSON.stringify(body.data)).not.toContain("hidden-key");
});
it("refuses foreign organization injection", async () => {
  expect(
    (
      await call({
        action: "configure",
        api_key: "secret-input",
        profile_id: "a".repeat(24),
        organization_id: "other",
      })
    ).status,
  ).toBe(400);
  expect(h.configure).not.toHaveBeenCalled();
});
it("saves under trusted tenant and audits without secrets", async () => {
  expect(
    (await call({ action: "configure", api_key: "secret-input", profile_id: "a".repeat(24) }))
      .status,
  ).toBe(200);
  expect(h.configure).toHaveBeenCalledWith({}, "trusted", "secret-input", "a".repeat(24));
  expect(JSON.stringify(h.audit.mock.calls)).not.toContain("secret-input");
});
it("blocks missing role, read-only support and missing MFA proof", async () => {
  h.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
  expect((await call({})).status).toBe(403);
  h.support.mockResolvedValue(new Response(null, { status: 403 }));
  expect((await call({})).status).toBe(403);
  h.support.mockResolvedValue(null);
  h.role.mockResolvedValue({ ok: true, org: { orgId: "trusted" }, user: { id: "admin" } });
  h.mfa.mockResolvedValue(true);
  expect((await call({})).status).toBe(403);
  expect(h.configure).not.toHaveBeenCalled();
});
it("returns no orphaned channels without a configured profile", async () => {
  h.read.mockResolvedValue(null);
  h.channels.mockResolvedValue([
    { id: "ch-1", accountId: "b".repeat(24), display_name: "IG", status: "FAILED" },
  ]);
  const response = await GET();
  const body = (await response.json()) as { data: { orphaned_channels: unknown[] } };
  expect(body.data.orphaned_channels).toEqual([]);
});
it("disconnects under the trusted tenant and audits the outcome", async () => {
  h.disconnect.mockResolvedValue({ channel_id: "ch", account_removed: true });
  const response = await call({
    action: "disconnect",
    account_id: "a".repeat(24),
    remove_account: true,
  });
  expect(response.status).toBe(200);
  expect(h.disconnect).toHaveBeenCalledWith({}, "trusted", "a".repeat(24), true);
  expect(h.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "channel.social_disconnected",
      organizationId: "trusted",
      metadata: expect.objectContaining({ channel_id: "ch", account_removed: true }),
    }),
  );
  expect((await call({ action: "disconnect", account_id: "a".repeat(24) })).status).toBe(400);
});
it("unlinks the profile under the trusted tenant and audits without secrets", async () => {
  h.unlink.mockResolvedValue({ desvinculado: true, avisos_fechados: "sem_mudanca" });
  const response = await call({ action: "unlink" });
  expect(response.status).toBe(200);
  expect(h.unlink).toHaveBeenCalledWith({}, "trusted");
  expect(h.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "channel.social_desvinculado",
      organizationId: "trusted",
      metadata: expect.objectContaining({ operation: "unlink", desvinculado: true }),
    }),
  );
  expect(JSON.stringify(h.audit.mock.calls)).not.toContain("secret-input");
});
