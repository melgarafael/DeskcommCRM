/**
 * G2-01 — helper único de autorização (spec 13 §4).
 *
 * Prova: 401 sem sessão; 403 forbidden_tenant sem org; 403 forbidden_role
 * padronizado com audit `authz.denied` (sem PII); grant no role mínimo;
 * fail-closed quando fn_user_role_in_org devolve null (membership revogado);
 * bypass de platform admin só com opt-in.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { orgAtivaDaApi, requireRole } from "@/lib/auth/require-role";
import { loadAuthUser, mfaEmDivida, orgAtivaSemPortao } from "@/lib/auth/server";
import { audit } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";
import type { AuthUser, Role } from "@/lib/auth/types";

vi.mock("@/lib/auth/server", () => ({
  // Sessão sem dívida de MFA: esta suíte mede rank de papel; o gate de segundo
  // fator tem suíte própria em tests/unit/require-role-mfa.test.ts.
  mfaEmDivida: vi.fn(async () => false),
  loadAuthUser: vi.fn(),
  orgAtivaSemPortao: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

function authUserFixture(role: Role | null, platformAdmin = false, scope = "full"): AuthUser {
  return {
    id: USER_ID,
    email: "user@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: platformAdmin,
    platform_admin_scope: platformAdmin ? scope : null,
    idioma: "pt-BR" as const,
    organizations: role
      ? [{ organization_id: ORG_ID, organization_name: "Org", role, org_status: "active" }]
      : [],
  };
}

/** Configura sessão + role efetivo devolvido pelo banco (fn_user_role_in_org). */
function session(
  role: Role | null,
  opts: { dbRole?: string | null; platformAdmin?: boolean; scope?: string; orgStatus?: string } = {},
) {
  const platformAdmin = opts.platformAdmin ?? false;
  const dbRole = opts.dbRole === undefined ? role : opts.dbRole;
  vi.mocked(loadAuthUser).mockResolvedValue(
    role || platformAdmin ? authUserFixture(role, platformAdmin, opts.scope ?? "full") : null,
  );
  vi.mocked(orgAtivaSemPortao).mockResolvedValue(
    role ? { orgId: ORG_ID, name: "Org", role, org_status: opts.orgStatus ?? "active" } : null,
  );
  vi.mocked(createClient).mockResolvedValue({
    rpc: vi.fn(async (fn: string) =>
      fn === "fn_user_role_in_org" ? { data: dbRole, error: null } : { data: null, error: null },
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireRole — helper único (spec 13 §4)", () => {
  it("nega 401 unauthenticated sem sessão", async () => {
    session(null);
    const res = await requireRole("viewer");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.response.status).toBe(401);
    const body = await res.response.json();
    expect(body.error.code).toBe("unauthenticated");
  });

  it("nega 403 forbidden_tenant sem org ativa", async () => {
    session("agent");
    vi.mocked(orgAtivaSemPortao).mockResolvedValue(null);
    const res = await requireRole("viewer");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.response.status).toBe(403);
    const body = await res.response.json();
    expect(body.error.code).toBe("forbidden_tenant");
  });

  it("nega 403 forbidden_role padronizado + audita authz.denied (sem PII)", async () => {
    session("agent");
    const res = await requireRole("manager", { requestId: "req-1", resource: "team" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.response.status).toBe(403);
    const body = await res.response.json();
    expect(body.error.code).toBe("forbidden_role");

    expect(audit).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(audit).mock.calls[0]![0];
    expect(entry.action).toBe("authz.denied");
    expect(entry.actorUserId).toBe(USER_ID);
    expect(entry.organizationId).toBe(ORG_ID);
    expect(entry.resourceType).toBe("team");
    expect(entry.metadata).toEqual({ required_role: "manager", effective_role: "agent" });
    // LGPD: nada de PII no payload de audit
    expect(JSON.stringify(entry.metadata)).not.toContain("@");
  });

  it("permite no role mínimo exato (role efetivo vem do banco)", async () => {
    session("manager");
    const res = await requireRole("manager");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.org.orgId).toBe(ORG_ID);
    expect(res.org.role).toBe("manager");
    expect(audit).not.toHaveBeenCalled();
  });

  it("fail-closed: fn_user_role_in_org null (membership revogado) → 403", async () => {
    session("admin", { dbRole: null });
    const res = await requireRole("viewer");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.response.status).toBe(403);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  // Override de org (ex.: LGPD anonymize — role resolvido na org do CONTATO,
  // não na org ativa do cookie).
  describe("opts.organizationId (org do recurso)", () => {
    const OTHER_ORG = "33333333-3333-4333-8333-333333333333";

    /** User membro de 2 orgs; org ativa = ORG_ID; role no banco varia por p_org. */
    function dualOrgSession(roleInActive: Role, roleInOther: Role | null) {
      vi.mocked(loadAuthUser).mockResolvedValue({
        ...authUserFixture(roleInActive),
        organizations: [
          { organization_id: ORG_ID, organization_name: "Org A", role: roleInActive, org_status: "active" },
          ...(roleInOther
            ? [{ organization_id: OTHER_ORG, organization_name: "Org B", role: roleInOther, org_status: "active" }]
            : []),
        ],
      });
      vi.mocked(orgAtivaSemPortao).mockResolvedValue({
        orgId: ORG_ID,
        name: "Org A",
        role: roleInActive,
        org_status: "active",
      });
      vi.mocked(createClient).mockResolvedValue({
        rpc: vi.fn(async (fn: string, args: { p_org: string }) =>
          fn === "fn_user_role_in_org"
            ? { data: args.p_org === ORG_ID ? roleInActive : roleInOther, error: null }
            : { data: null, error: null },
        ),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }

    it("admin na org do recurso → ok, mesmo com org ativa diferente", async () => {
      dualOrgSession("agent", "admin");
      const res = await requireRole("admin", { organizationId: OTHER_ORG });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("unreachable");
      expect(res.org.orgId).toBe(OTHER_ORG);
      expect(res.org.role).toBe("admin");
    });

    it("agent na org do recurso → 403 + authz.denied NA org do recurso (mesmo sendo admin na ativa)", async () => {
      dualOrgSession("admin", "agent");
      const res = await requireRole("admin", { organizationId: OTHER_ORG, resource: "contact" });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("unreachable");
      expect(res.response.status).toBe(403);
      const body = await res.response.json();
      expect(body.error.code).toBe("forbidden_role");
      expect(audit).toHaveBeenCalledTimes(1);
      const entry = vi.mocked(audit).mock.calls[0]![0];
      expect(entry.action).toBe("authz.denied");
      expect(entry.organizationId).toBe(OTHER_ORG);
      expect(entry.metadata).toEqual({ required_role: "admin", effective_role: "agent" });
    });

    it("sem membership na org do recurso (e sem platform admin) → 403 fail-closed", async () => {
      dualOrgSession("admin", null);
      const res = await requireRole("admin", { organizationId: OTHER_ORG });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("unreachable");
      expect(res.response.status).toBe(403);
      const body = await res.response.json();
      expect(body.error.code).toBe("forbidden_tenant");
    });
  });

  it("platform admin NÃO bypassa por default; bypassa com allowPlatformAdmin", async () => {
    session("viewer", { platformAdmin: true });
    const denied = await requireRole("admin");
    expect(denied.ok).toBe(false);

    session("viewer", { platformAdmin: true });
    const granted = await requireRole("admin", { allowPlatformAdmin: true });
    expect(granted.ok).toBe(true);
  });
});

describe("org não operante e scope do platform admin (spec cobrança §4 item 4)", () => {
  it("org suspensa → 403 org_suspended, sem ler papel", async () => {
    session("admin", { orgStatus: "suspended" });
    const res = await requireRole("viewer");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.response.status).toBe(403);
    expect((await res.response.json()).error.code).toBe("org_suspended");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("permiteOrgSuspensa libera a org suspensa (LGPD)", async () => {
    session("admin", { orgStatus: "suspended" });
    expect((await requireRole("admin", { permiteOrgSuspensa: true })).ok).toBe(true);
  });

  it("o atalho de platform admin NÃO atravessa a suspensão", async () => {
    session("viewer", { platformAdmin: true, orgStatus: "suspended" });
    const res = await requireRole("admin", { allowPlatformAdmin: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect((await res.response.json()).error.code).toBe("org_suspended");
  });

  it("allowPlatformAdmin:true com support_readonly NÃO bypassa (cai no rank → 403)", async () => {
    session("viewer", { platformAdmin: true, scope: "support_readonly" });
    const res = await requireRole("admin", { allowPlatformAdmin: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect((await res.response.json()).error.code).toBe("forbidden_role");
  });

  it("allowPlatformAdmin:true com full e MFA em dívida → 403 mfa_required", async () => {
    session("viewer", { platformAdmin: true });
    vi.mocked(mfaEmDivida).mockResolvedValueOnce(true);
    const res = await requireRole("admin", { allowPlatformAdmin: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect((await res.response.json()).error.code).toBe("mfa_required");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("allowPlatformAdmin:'leitura' libera support_readonly", async () => {
    session("viewer", { platformAdmin: true, scope: "support_readonly" });
    expect((await requireRole("admin", { allowPlatformAdmin: "leitura" })).ok).toBe(true);
  });

  it("CONTROLE: full com sessão em dia bypassa sem ler papel", async () => {
    session("viewer", { platformAdmin: true });
    expect((await requireRole("admin", { allowPlatformAdmin: true })).ok).toBe(true);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("org do RECURSO suspensa → org_suspended; com permiteOrgSuspensa segue ao papel", async () => {
    const OUTRA = "33333333-3333-4333-8333-333333333333";
    vi.mocked(loadAuthUser).mockResolvedValue({
      ...authUserFixture("admin"),
      organizations: [
        { organization_id: ORG_ID, organization_name: "A", role: "admin", org_status: "active" },
        { organization_id: OUTRA, organization_name: "B", role: "admin", org_status: "suspended" },
      ],
    });
    vi.mocked(createClient).mockResolvedValue({
      rpc: vi.fn(async () => ({ data: "admin", error: null })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const barrado = await requireRole("admin", { organizationId: OUTRA });
    expect(barrado.ok).toBe(false);
    if (!barrado.ok) expect((await barrado.response.json()).error.code).toBe("org_suspended");
    expect((await requireRole("admin", { organizationId: OUTRA, permiteOrgSuspensa: true })).ok).toBe(true);
  });
});

/**
 * `orgAtivaDaApi` — a org ativa das rotas que não passam por `requireRole`
 * (acabamentos do PR 1, itens 6 e 23). Org suspensa responde o MESMO 403 JSON
 * de `requireRole`, nunca o redirect de `resolveActiveOrg`.
 */
describe("orgAtivaDaApi", () => {
  it("org suspensa → 403 org_suspended em JSON, com o requestId", async () => {
    session("admin", { orgStatus: "suspended" });
    const res = await orgAtivaDaApi(authUserFixture("admin"), "req-1");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.response.status).toBe(403);
    expect(res.response.headers.get("location")).toBeNull();
    const body = await res.response.json();
    expect(body.error.code).toBe("org_suspended");
    expect(body.error.message).toBe("A conta desta empresa está suspensa.");
  });

  it("org operante → devolve a org", async () => {
    session("agent");
    const res = await orgAtivaDaApi(authUserFixture("agent"));
    expect(res).toEqual({ ok: true, org: expect.objectContaining({ orgId: ORG_ID }) });
  });

  it("sem org, ou sem usuário → org nula, e a rota responde o seu próprio 'sem org'", async () => {
    session(null);
    expect(await orgAtivaDaApi(authUserFixture(null))).toEqual({ ok: true, org: null });
    expect(await orgAtivaDaApi(null)).toEqual({ ok: true, org: null });
  });
});
