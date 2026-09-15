import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({ setCookie: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: mocks.setCookie }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/cookie-secure", () => ({ cookieSecure: () => false }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/env", () => ({ env: {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000", ADVOMAX_API_URL: "http://localhost:8080",
  ADVOMAX_CRM_INTEGRATION_KEY: "local-test-key",
} }));

const userId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";
const handoff = { email: "ana@example.com", nome: "Ana", usuarioCodigo: 12,
  empresaCodigo: 34, empresaNome: "Escritório Ana", crmOrganizationId: orgId, perfilCodigo: 1, produto: "crm" };
const user = { id: userId, email: handoff.email, email_confirmed_at: "2026-09-14T00:00:00.000Z", app_metadata: { advomax_user_codigo: 12 } };
const state = "s".repeat(43);
function request(cookie: string | null = state) {
  return new NextRequest(`http://localhost:3000/auth/advomax?code=${"c".repeat(43)}&state=${state}`, {
    headers: cookie === null ? {} : { cookie: `advomax_sso_state=${cookie}` },
  });
}
function setup() {
  const results: Record<string, Array<{ data: unknown; error: unknown }>> = {
    organizations: [{ data: { id: orgId, status: "active", advomax_empresa_codigo: 34, created_by: userId }, error: null }],
    user_organizations: [{ data: { id: "membership", revoked_at: null, accepted_at: "2026-09-14" }, error: null }],
  };
  const insert = vi.fn(() => { throw new Error("Unexpected insert"); });
  const remove = vi.fn(() => { throw new Error("Unexpected delete"); });
  const from = vi.fn((table: string) => {
    const query = { select: vi.fn(() => query), eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => {
        const result = results[table]?.shift();
        if (!result) throw new Error(`Missing test result for ${table}`);
        return result;
      }), insert, delete: remove };
    return query;
  });
  const admin = { from, auth: { admin: {
    listUsers: vi.fn().mockResolvedValue({ data: { users: [user] }, error: null }),
    updateUserById: vi.fn().mockResolvedValue({ data: { user }, error: null }),
    createUser: vi.fn(),
    generateLink: vi.fn().mockResolvedValue({ data: { user, properties: { hashed_token: "server-only-hash" } }, error: null }),
  } } };
  const session = { auth: {
    getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
    verifyOtp: vi.fn().mockResolvedValue({ data: { user, session: { access_token: "server-only-token" } }, error: null }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
  } };
  vi.mocked(createAdminClient).mockReturnValue(admin as unknown as ReturnType<typeof createAdminClient>);
  vi.mocked(createClient).mockResolvedValue(session as unknown as Awaited<ReturnType<typeof createClient>>);
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(handoff), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return { admin, session, fetchMock, results, insert, remove };
}
const location = (response: Response) => response.headers.get("location");
beforeEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("entrada Advomax no CRM", () => {
  it.each([null, "x".repeat(43), "short"])("recusa cookie inválido %s antes de acessar serviços", async (cookie) => {
    const s = setup();
    expect(location(await GET(request(cookie)))).toContain("error=sso_invalido");
    expect(s.fetchMock).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });
  it("grava sessão SSR e escritório autorizado sem enviar credenciais no redirecionamento", async () => {
    const s = setup();
    const response = await GET(request());
    expect(location(response)).toBe("http://localhost:3000/app");
    expect(s.session.auth.verifyOtp).toHaveBeenCalledWith({ type: "magiclink", token_hash: "server-only-hash" });
    expect(mocks.setCookie).toHaveBeenCalledWith("active_org", orgId, expect.objectContaining({ httpOnly: true, sameSite: "strict", path: "/" }));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it.each([
    { revoked_at: "2026-09-14", accepted_at: "2026-09-13" },
    { revoked_at: null, accepted_at: null },
  ])("não reativa vínculo revogado ou convite pendente", async (membership) => {
    const s = setup();
    s.results.user_organizations = [{ data: { id: "membership", ...membership }, error: null }];
    expect(location(await GET(request()))).toContain("error=sso_membership");
    expect(s.insert).not.toHaveBeenCalled();
    expect(s.admin.auth.admin.generateLink).not.toHaveBeenCalled();
  });
  it("funcionário sem vínculo precisa de convite", async () => {
    const s = setup();
    s.fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...handoff, perfilCodigo: 2 })));
    s.results.user_organizations = [{ data: null, error: null }];
    expect(location(await GET(request()))).toContain("error=sso_convite");
    expect(s.insert).not.toHaveBeenCalled();
    expect(s.session.auth.verifyOtp).not.toHaveBeenCalled();
  });
  it.each([{ status: "suspended", advomax_empresa_codigo: 34 }, { status: "active", advomax_empresa_codigo: 999 }])("recusa escritório suspenso ou de outra empresa", async (org) => {
    const s = setup();
    s.results.organizations = [{ data: { id: orgId, created_by: userId, ...org }, error: null }];
    expect(location(await GET(request()))).toContain("error=sso_organizacao");
    expect(s.session.auth.verifyOtp).not.toHaveBeenCalled();
  });
  it("preserva organização se a resposta de provisionamento se perde", async () => {
    const s = setup();
    s.results.organizations!.unshift({ data: { id: orgId }, error: null });
    s.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...handoff, crmOrganizationId: null })))
      .mockRejectedValueOnce(new Error("timeout after commit"));
    expect(location(await GET(request()))).toContain("error=sso_provisionamento");
    expect(s.remove).not.toHaveBeenCalled();
    expect(s.session.auth.verifyOtp).not.toHaveBeenCalled();
  });
  it("não associa por email nem confia em user_metadata sem email confirmado", async () => {
    const s = setup();
    s.admin.auth.admin.listUsers.mockResolvedValue({ data: { users: [{ ...user, email_confirmed_at: null, app_metadata: {}, user_metadata: { advomax_user_codigo: 12 } }] }, error: null });
    expect(location(await GET(request()))).toContain("error=sso_identidade");
    expect(s.admin.auth.admin.updateUserById).not.toHaveBeenCalled();
    expect(s.session.auth.verifyOtp).not.toHaveBeenCalled();
  });
  it("vincula uma conta CRM existente somente com email confirmado e sem identidade conflitante", async () => {
    const s = setup();
    s.admin.auth.admin.listUsers.mockResolvedValue({ data: { users: [{ ...user, app_metadata: {}, user_metadata: {} }] }, error: null });
    s.session.auth.getUser.mockResolvedValue({ data: { user }, error: null });
    expect(location(await GET(request()))).toBe("http://localhost:3000/app");
    expect(s.admin.auth.admin.updateUserById).toHaveBeenCalledWith(userId, expect.objectContaining({ app_metadata: expect.objectContaining({ advomax_user_codigo: 12 }) }));
  });
  it("localiza identidade além da primeira página sem criar conta duplicada", async () => {
    const s = setup();
    s.admin.auth.admin.listUsers.mockResolvedValueOnce({ data: { users: [], nextPage: 2 }, error: null });
    expect(location(await GET(request()))).toBe("http://localhost:3000/app");
    expect(s.admin.auth.admin.listUsers).toHaveBeenNthCalledWith(2, { page: 2, perPage: 1000 });
    expect(s.admin.auth.admin.createUser).not.toHaveBeenCalled();
  });
  it("recusa contrato inválido antes do provisionamento", async () => {
    const s = setup();
    s.fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...handoff, empresaCodigo: -1 })));
    expect(location(await GET(request()))).toContain("error=sso_invalido");
    expect(createAdminClient).not.toHaveBeenCalled();
  });
  it("descarta sessão de identidade divergente e não escolhe escritório", async () => {
    const s = setup();
    s.session.auth.verifyOtp.mockResolvedValue({ data: { user: { ...user, id: orgId }, session: {} }, error: null });
    expect(location(await GET(request()))).toContain("error=sso_sessao");
    expect(s.session.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.setCookie.mock.calls.some(([name]) => name === "active_org")).toBe(false);
  });
});
