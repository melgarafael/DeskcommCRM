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
  socialChannels: h.channels,
  connectSocialInbox: vi.fn(),
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
