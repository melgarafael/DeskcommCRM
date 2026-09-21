import { beforeEach, describe, expect, it, vi } from "vitest";
const config = vi.fn();
const accounts = vi.fn();
const request = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/social/store", () => ({
  readSocialIntegration: (...args: unknown[]) => config(...args),
}));
vi.mock("@/lib/channels/social/client", () => ({
  listSocialAccounts: (...args: unknown[]) => accounts(...args),
  socialRequest: (...args: unknown[]) => request(...args),
  SocialError: class extends Error {},
}));
import { instagramInsights } from "@/lib/channels/social/instagram-insights";
beforeEach(() => {
  vi.clearAllMocks();
  config.mockResolvedValue({ key: "private-test", profileId: "org-profile" });
  accounts.mockResolvedValue([
    { _id: "own", platform: "instagram", isActive: true, username: "loja" },
  ]);
});
describe("Instagram results are scoped to the organization's connected account", () => {
  it("does not contact analytics for a foreign account", async () => {
    await expect(instagramInsights("org", "foreign")).rejects.toThrow("Conta não encontrada");
    expect(request).not.toHaveBeenCalled();
    expect(accounts).toHaveBeenCalledWith("private-test", "org-profile");
  });
  it("leaves missing metrics absent instead of manufacturing zero", async () => {
    request.mockResolvedValue({
      success: true,
      accountId: "own",
      dateRange: { since: "2026-08-21", until: "2026-09-20" },
      metrics: { reach: { total: 42 } },
    });
    const result = await instagramInsights("org", "own");
    expect(result.insights?.metrics.reach?.total).toBe(42);
    expect(result.insights?.metrics.views).toBeUndefined();
  });
  it("rejects a provider response for another account", async () => {
    request.mockResolvedValue({
      success: true,
      accountId: "foreign",
      dateRange: { since: "2026-08-21", until: "2026-09-20" },
      metrics: {},
    });
    await expect(instagramInsights("org", "own")).rejects.toThrow("não corresponde");
  });
  it("shows connection needed without making an external request", async () => {
    config.mockResolvedValue(null);
    expect(await instagramInsights("org")).toEqual({ connected: false, accounts: [] });
    expect(accounts).not.toHaveBeenCalled();
  });
});
