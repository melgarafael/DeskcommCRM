import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const h = vi.hoisted(() => ({
  guard: vi.fn(), mfa: vi.fn(), rpc: vi.fn(), audit: vi.fn(), invite: vi.fn(),
  user: vi.fn(), query: vi.fn(), cookie: vi.fn(), getCookie: vi.fn(),
}));
vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: h.guard }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: h.mfa, loadAuthUser: h.user }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: h.rpc }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: h.query }) }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/auth/issue-invite", () => ({ issueInvite: h.invite }));
vi.mock("@/lib/supabase/cookie-secure", () => ({ cookieSecure: () => false }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: h.cookie, get: h.getCookie }) }));
import { POST } from "@/app/api/v1/admin/tenants/route";
import { setActiveOrg } from "@/app/actions/shell/setActiveOrg";
const actor = "a2180000-0000-4000-8000-000000000001";
const org = "a2180000-0000-4000-8000-000000000002";
function request(email = "owner@example.test", key = "a2180000-0000-4000-8000-000000000003") {
  return new NextRequest("http://localhost/api/v1/admin/tenants", { method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ display_name: "Minha organização", slug: "minha-org", owner_email: email }) });
}
beforeEach(() => {
  vi.resetAllMocks();
  h.guard.mockResolvedValue({ user: { id: actor, email: "owner@example.test", user_metadata: {} }, platformAdmin: { scope: "full" } });
  h.user.mockResolvedValue({ id: actor, is_platform_admin: true, organizations: [] });
  h.mfa.mockResolvedValue(false);
  h.rpc.mockResolvedValue({ data: { id: org, display_name: "Minha organização", slug: "minha-org", created: true, invite_id: actor, issued_at: 12345 }, error: null });
  h.invite.mockResolvedValue({ accept_url: "http://localhost/invite", email_dispatched: false });
});
describe("criação administrativa", () => {
  it("não cria nem convida em suporte readonly, sem auth ou em dívida MFA", async () => {
    h.guard.mockRejectedValueOnce(new Error("forbidden"));
    expect((await POST(request())).status).toBe(403);
    h.guard.mockResolvedValueOnce({ user: { id: actor }, platformAdmin: { scope: "support_readonly" } });
    expect((await POST(request())).status).toBe(403);
    h.mfa.mockResolvedValueOnce(true);
    expect((await POST(request())).status).toBe(403);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("o próprio responsável já ganha vínculo, sem convite duplicado", async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect((await response.json()).data.owner_invitation).toBeNull();
    expect(h.rpc).toHaveBeenCalledWith("fn_create_tenant_with_owner", expect.objectContaining({ p_actor: actor }));
    expect(h.invite).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ organizationId: org, metadata: expect.objectContaining({ creator_role: "admin" }) }));
  });
  it("responsável distinto recebe link após commit, inclusive sem envio", async () => {
    const response = await POST(request("guest@example.test"));
    expect((await response.json()).data.owner_invitation.email_dispatched).toBe(false);
    expect(h.rpc.mock.invocationCallOrder[0]).toBeLessThan(h.invite.mock.invocationCallOrder[0]!);
    expect(h.invite).toHaveBeenCalledWith(expect.objectContaining({ organizationId: org, inviterId: actor, role: "admin" }));
  });
  it("recusa chave inválida; falha SQL não convida", async () => {
    expect((await POST(request("guest@example.test", "bad"))).status).toBe(400);
    h.rpc.mockResolvedValueOnce({ error: { code: "23505" } });
    expect((await POST(request("guest@example.test"))).status).toBe(409);
    expect(h.invite).not.toHaveBeenCalled();
  });
  it("replay recupera o convite sem reenviar nem duplicar audit da criação", async () => {
    h.rpc.mockResolvedValueOnce({ data: { id: org, created: false, invite_id: actor, issued_at: 12345 } });
    expect((await POST(request("guest@example.test"))).status).toBe(201);
    expect(h.invite).toHaveBeenCalledWith(expect.objectContaining({ dispatch: false }));
    expect(h.audit).not.toHaveBeenCalled();
  });
});
describe("troca normal exige vínculo ativo mesmo sendo platform admin", () => {
  function membership(data: unknown) {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "not"]) chain[method] = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data }));
    h.query.mockReturnValue(chain);
    return chain;
  }
  it("valida UUID antes de gravar cookie", async () => {
    expect((await setActiveOrg("invalid")).ok).toBe(false);
    expect(h.cookie).not.toHaveBeenCalled();
  });
  it("não inventa bypass de platform admin", async () => {
    membership(null);
    expect((await setActiveOrg(org)).ok).toBe(false);
    expect(h.cookie).not.toHaveBeenCalled();
  });
  it("filtra aceito/ativo e audita org alvo com ator autenticado", async () => {
    const chain = membership({ organization_id: org });
    expect((await setActiveOrg(org)).ok).toBe(true);
    expect(chain.eq).toHaveBeenCalledWith("organizations.status", "active");
    expect(chain.not).toHaveBeenCalledWith("accepted_at", "is", null);
    expect(h.cookie).toHaveBeenCalledWith("active_org", org, expect.objectContaining({ httpOnly: true, sameSite: "strict" }));
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "organization.switched", actorUserId: actor, organizationId: org }));
  });
});
