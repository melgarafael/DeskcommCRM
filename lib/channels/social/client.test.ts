import { afterEach, describe, expect, it, vi } from "vitest";
import { listSocialAccounts, socialRequest } from "./client";
afterEach(() => vi.unstubAllGlobals());
describe("social provider boundary", () => {
  it("filters upstream accounts by the configured profile and projects no credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accounts: [
              { _id: "a", platform: "instagram", isActive: true, profileId: { _id: "p" } },
              { _id: "b", platform: "facebook", isActive: true, profileId: "other" },
            ],
          }),
        ),
      ),
    );
    expect((await listSocialAccounts("test-key", "p")).map((a) => a._id)).toEqual(["a"]);
  });
  it("never includes upstream error bodies or credentials in errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret-body", { status: 403 })));
    await expect(socialRequest("test-key", "profiles")).rejects.toThrow("Acesso recusado");
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: "error", cache: "no-store" }),
    );
  });
});
