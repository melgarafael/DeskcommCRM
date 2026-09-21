import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { GET } from "@/app/auth/social-return/route";
import { isPublicPath } from "@/lib/auth/public-paths";
import { readFileSync } from "node:fs";
describe("social OAuth return", () => {
  it("exposes only the inert landing, never the protected connections", () => {
    expect(isPublicPath("/auth/social-return")).toBe(true);
    expect(isPublicPath("/auth/social-return/admin")).toBe(false);
    expect(isPublicPath("/app/connections")).toBe(false);
    expect(isPublicPath("/api/v1/channels/social")).toBe(false);
  });
  it("commits a same-origin document with a fixed destination and no token reflection", async () => {
    const response = GET();
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const script = html.match(/<script>(.*?)<\/script>/)![1]!;
    expect(script).toBe('window.location.replace("/app/connections?aba=sociais");');
    expect(response.headers.get("content-security-policy")).toContain(
      createHash("sha256").update(script).digest("base64"),
    );
    expect(html).not.toContain("connect_token");
  });
  it("sends newly issued authorization flows to the landing", () => {
    expect(readFileSync("app/api/v1/channels/social/route.ts", "utf8")).toContain(
      "redirect_url: `${publicBase()}/auth/social-return`",
    );
  });
});
