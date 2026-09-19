import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  support: vi.fn(),
  mfa: vi.fn(),
  rate: vi.fn(),
  read: vi.fn(),
  perform: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.auth }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.support }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: mocks.mfa }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: mocks.rate }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => "pool" }));
vi.mock("@/lib/ai/voice/store", () => ({
  readVoicePanel: mocks.read,
  performVoiceAction: mocks.perform,
}));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
import { GET, POST } from "@/app/api/v1/ai/agents/[id]/voice/route";
const id = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ id }) };
const req = (body: unknown) =>
  new Request("https://crm.test/api/voice", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ ok: true, org: { orgId: "trusted-org" }, user: { id: "user" } });
  mocks.support.mockResolvedValue(null);
  mocks.mfa.mockResolvedValue(false);
  mocks.rate.mockResolvedValue({ allowed: true });
  mocks.read.mockResolvedValue({ configured: false });
  mocks.perform.mockResolvedValue({ configured: true });
});
it("requires admin before reading tenant configuration and never caches it", async () => {
  const response = await GET(new Request("https://crm.test"), ctx);
  expect(mocks.auth).toHaveBeenCalledWith("admin", expect.anything());
  expect(mocks.read).toHaveBeenCalledWith("pool", "trusted-org", id);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
it("refuses support-read sessions before doing any work", async () => {
  mocks.support.mockResolvedValue(new Response(null, { status: 403 }));
  expect((await POST(req({ action: "test" }), ctx)).status).toBe(403);
  expect(mocks.perform).not.toHaveBeenCalled();
});
it("rejects tenant or remote-agent injection", async () => {
  expect((await POST(req({ action: "test", organization_id: "foreign-org" }), ctx)).status).toBe(
    422,
  );
  expect(mocks.perform).not.toHaveBeenCalled();
});
it.each(["mfa", "role", "rate"])(
  "blocks %s failures before issuing a signed session",
  async (failure) => {
    if (failure === "mfa") mocks.mfa.mockResolvedValue(true);
    if (failure === "role")
      mocks.auth.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    if (failure === "rate") mocks.rate.mockResolvedValue({ allowed: false });
    expect((await POST(req({ action: "test" }), ctx)).status).toBe(failure === "rate" ? 429 : 403);
    expect(mocks.perform).not.toHaveBeenCalled();
  },
);
it("audits operation without credentials or signed session token", async () => {
  const secret = "fixture-credential-never-returned";
  const response = await POST(req({ action: "credential", api_key: secret }), ctx);
  expect(response.status).toBe(200);
  expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(secret);
  expect(await response.text()).not.toContain(secret);
  expect(mocks.perform).toHaveBeenCalledWith("pool", "trusted-org", "user", id, {
    action: "credential",
    api_key: secret,
  });
});
it("does not expose unknown provider errors", async () => {
  mocks.perform.mockRejectedValue(new Error("key=secret-value body=provider-payload"));
  const response = await POST(req({ action: "test" }), ctx);
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("secret-value");
});
