import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  mfa: vi.fn(),
  rpc: vi.fn(),
  client: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.support }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: h.mfa }));
vi.mock("@/lib/supabase/server", () => ({ createClient: h.client }));

import { POST } from "./route";

const org = "ad660001-0000-4000-8000-000000000001";
const source = "ad660001-0000-4000-8000-000000000002";
const channel = "ad660001-0000-4000-8000-000000000003";
const lead = "ad660001-0000-4000-8000-000000000004";
const call = (body: unknown) =>
  POST(
    new Request("http://127.0.0.1:3109/api/v1/team/operational-boundaries", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.resetAllMocks();
  h.role.mockResolvedValue({ ok: true, org: { orgId: org } });
  h.support.mockResolvedValue(null);
  h.mfa.mockResolvedValue(false);
  h.client.mockResolvedValue({ rpc: h.rpc });
  h.rpc.mockResolvedValue({ data: { status: "assigned" }, error: null });
});

it("binds explicit source to channel using only trusted organization", async () => {
  const response = await call({
    action: "commercial_source",
    source_id: source,
    channel_id: channel,
    disabled: false,
  });
  expect(response.status).toBe(200);

  expect(h.role).toHaveBeenCalledWith("admin", expect.anything());
  expect(h.rpc).toHaveBeenCalledExactlyOnceWith("fn_set_commercial_source", {
    p_org: org,
    p_source: source,
    p_channel: channel,
    p_disabled: false,
  });
});

it("preserves explicit disabling instead of silently enabling a binding", async () => {
  expect(
    (
      await call({
        action: "commercial_source",
        source_id: source,
        channel_id: channel,
        disabled: true,
      })
    ).status,
  ).toBe(200);
  expect(h.rpc.mock.calls[0]?.[1]).toEqual({
    p_org: org,
    p_source: source,
    p_channel: channel,
    p_disabled: true,
  });
});

it("returns recoverable pending result without inventing conversation or claim", async () => {
  h.rpc.mockResolvedValue({ data: { status: "pending" }, error: null });
  const response = await call({ action: "commercial_source_retry", lead_id: lead });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { status: "pending" } });
  expect(h.rpc).toHaveBeenCalledExactlyOnceWith("fn_commercial_source_ingress", {
    p_org: org,
    p_lead: lead,
  });
});

it.each([
  {
    action: "commercial_source",
    source_id: source,
    channel_id: channel,
    disabled: false,
    organization_id: org,
  },
  { action: "commercial_source", source_id: source, disabled: false },
  { action: "commercial_source", source_id: "not-a-uuid", channel_id: channel, disabled: false },
  { action: "commercial_source_retry", lead_id: lead, conversation_id: source },
])("rejects malformed or authority-extending input %j", async (body) => {
  expect((await call(body)).status).toBe(422);
  expect(h.rpc).not.toHaveBeenCalled();
});

it("does not call database when support is read-only", async () => {
  h.support.mockResolvedValue(new Response(null, { status: 403 }));
  expect((await call({ action: "commercial_source_retry", lead_id: lead })).status).toBe(403);
  expect(h.role).not.toHaveBeenCalled();
  expect(h.client).not.toHaveBeenCalled();
});

it("does not call database for non-admin", async () => {
  h.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
  expect((await call({ action: "commercial_source_retry", lead_id: lead })).status).toBe(403);
  expect(h.client).not.toHaveBeenCalled();
});

it("requires MFA before mutation", async () => {
  h.mfa.mockResolvedValue(true);
  expect((await call({ action: "commercial_source_retry", lead_id: lead })).status).toBe(403);
  expect(h.client).not.toHaveBeenCalled();
});

it.each([
  ["42501", 403],
  ["23514", 422],
] as const)("maps RPC error %s without leaking database details", async (code, status) => {
  h.rpc.mockResolvedValue({ data: null, error: { code, message: "private-database-details" } });
  const response = await call({ action: "commercial_source_retry", lead_id: lead });
  expect(response.status).toBe(status);
  expect(JSON.stringify(await response.json())).not.toContain("private-database-details");
});
