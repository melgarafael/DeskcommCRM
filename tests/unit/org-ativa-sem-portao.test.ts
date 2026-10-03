import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthUser, UserOrgMembership } from "@/lib/auth/types";
import { ehOperante } from "@/lib/organizacao/operante";

const estado = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (estado.cookie ? { value: estado.cookie } : undefined),
    getAll: () => [],
    set: () => {},
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect:${destino}`);
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
// O ramo de acompanhamento lê fuso, moeda e país por service role (#1945).
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const c = {
        select: () => c,
        eq: () => c,
        maybeSingle: async () => ({ data: { timezone: null, currency: null, country: null } }),
      };
      return c;
    },
  }),
}));

const { orgAtivaSemPortao, resolveActiveOrg } = await import("@/lib/auth/server");

const ATIVA = "aaaaaaaa-0000-4000-8000-000000000001";
const SUSPENSA = "aaaaaaaa-0000-4000-8000-000000000002";

function membro(id: string, org_status: string | null, suspended_kind: string | null = null): UserOrgMembership {
  return { organization_id: id, organization_name: id, role: "admin", org_status, suspended_kind };
}
function usuario(organizations: UserOrgMembership[], extra: Partial<AuthUser> = {}): AuthUser {
  return {
    id: "u1", email: "a@b.c", full_name: null, avatar_url: null,
    is_platform_admin: false, idioma: "pt-BR", organizations, ...extra,
  };
}

beforeEach(() => {
  estado.cookie = undefined;
});

describe("orgAtivaSemPortao / resolveActiveOrg — a org parada", () => {
  it("sem cookie, prefere a membership OPERANTE mesmo com a suspensa antes na ordem", async () => {
    const org = await orgAtivaSemPortao(usuario([membro(SUSPENSA, "suspended", "administrativa"), membro(ATIVA, "active")]));
    expect(org).toMatchObject({ orgId: ATIVA, org_status: "active" });
  });

  it("com cookie na suspensa, MANTÉM a suspensa (é por ela que se chega ao hub para pagar)", async () => {
    estado.cookie = SUSPENSA;
    const org = await orgAtivaSemPortao(usuario([membro(ATIVA, "active"), membro(SUSPENSA, "suspended", "cobranca")]));
    expect(org).toMatchObject({ orgId: SUSPENSA, org_status: "suspended", suspended_kind: "cobranca" });
  });

  it("cookie de org sem vínculo cai na primeira OPERANTE", async () => {
    estado.cookie = "ffffffff-0000-4000-8000-00000000000f";
    const org = await orgAtivaSemPortao(usuario([membro(SUSPENSA, "suspended", "administrativa"), membro(ATIVA, "active")]));
    expect(org?.orgId).toBe(ATIVA);
  });

  it("sem nenhuma operante cai na primeira, e resolveActiveOrg redireciona ao hub", async () => {
    const u = usuario([membro(SUSPENSA, "suspended", "administrativa")]);
    expect((await orgAtivaSemPortao(u))?.orgId).toBe(SUSPENSA);
    await expect(resolveActiveOrg(u)).rejects.toThrow("redirect:/account-suspended");
  });

  it("status desconhecido (null) também é parada — falha fechada", async () => {
    await expect(resolveActiveOrg(usuario([membro(ATIVA, null)]))).rejects.toThrow("redirect:/account-suspended");
  });

  it("CONTROLE: org operante passa por resolveActiveOrg sem redirecionar", async () => {
    await expect(resolveActiveOrg(usuario([membro(ATIVA, "active")]))).resolves.toMatchObject({ orgId: ATIVA });
  });

  // Review Focus 2: o layout (resolveActiveOrg) e o hub (orgAtivaSemPortao) têm
  // de escolher a MESMA org para o mesmo cookie; se divergirem, laço de 307.
  it.each([
    ["sem cookie, suspensa antes", undefined, [membro(SUSPENSA, "suspended", "administrativa"), membro(ATIVA, "active")]],
    ["cookie na suspensa", SUSPENSA, [membro(ATIVA, "active"), membro(SUSPENSA, "suspended", "cobranca")]],
    ["cookie na ativa", ATIVA, [membro(SUSPENSA, "suspended", "administrativa"), membro(ATIVA, "active")]],
    ["só a suspensa", undefined, [membro(SUSPENSA, "suspended", "administrativa")]],
    ["cookie órfão", "ffffffff-0000-4000-8000-00000000000f", [membro(SUSPENSA, "suspended", null)]],
  ] as const)("sem laço (%s): resolveActiveOrg redireciona SÓ quando a org de orgAtivaSemPortao não opera", async (_nome, cookie, orgs) => {
    estado.cookie = cookie;
    const u = usuario([...orgs]);
    const semPortao = await orgAtivaSemPortao(u);
    if (ehOperante(semPortao?.org_status)) {
      await expect(resolveActiveOrg(u)).resolves.toMatchObject({ orgId: semPortao!.orgId });
    } else {
      await expect(resolveActiveOrg(u)).rejects.toThrow("redirect:/account-suspended");
    }
  });

  it("acompanhamento ativo entra como operante; encerrado segue para /support-ended", async () => {
    const suporte = {
      id: "33333333-3333-4333-8333-333333333333", organization_id: SUSPENSA,
      actor_user_id: "u1", auth_session_id: "44444444-4444-4444-8444-444444444444",
      previous_organization_id: null, expires_at: "2099-01-01T00:00:00Z", name: "Org",
      locale: null, access_mode: "support_readonly" as const, status: "active" as const,
    };
    await expect(resolveActiveOrg(usuario([], { support: suporte }))).resolves.toMatchObject({
      orgId: SUSPENSA, role: "viewer", org_status: "active",
    });
    await expect(orgAtivaSemPortao(usuario([], { support: { ...suporte, status: "expired" } }))).rejects.toThrow(
      "redirect:/support-ended",
    );
  });
});
