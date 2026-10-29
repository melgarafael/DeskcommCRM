import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  user: vi.fn(),
  org: vi.fn(),
  pode: vi.fn(),
  suporte: vi.fn(),
  mfa: vi.fn(),
  rpc: vi.fn(),
  audit: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: deps.revalidate }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: deps.user,
  resolveActiveOrg: deps.org,
  mfaEmDivida: deps.mfa,
}));
vi.mock("@/lib/auth/pode-administrar-empresa", () => ({ podeAdministrarEmpresa: deps.pode }));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: deps.suporte }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: deps.rpc }) }));

import { definirLeadSubmittedCausal } from "./definirLeadSubmittedCausal";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  deps.user.mockResolvedValue({ id: "user-1", support: null });
  deps.org.mockResolvedValue({ orgId: ORG_A, role: "admin" });
  deps.pode.mockReturnValue(true);
  deps.suporte.mockReturnValue(false);
  deps.mfa.mockResolvedValue(false);
  deps.rpc.mockResolvedValue({ data: "2026-10-16T01:00:00Z", error: null });
  deps.audit.mockResolvedValue(undefined);
});

describe("controle causal por organização", () => {
  it("valida input e exige autenticação, papel administrativo e MFA", async () => {
    expect(await definirLeadSubmittedCausal("true" as never)).toEqual({
      ok: false,
      error: "validation_failed",
    });
    deps.user.mockResolvedValueOnce(null);
    expect(await definirLeadSubmittedCausal(true)).toEqual({ ok: false, error: "unauthenticated" });
    deps.pode.mockReturnValueOnce(false);
    expect(await definirLeadSubmittedCausal(true)).toEqual({ ok: false, error: "forbidden_role" });
    deps.mfa.mockResolvedValueOnce(true);
    expect(await definirLeadSubmittedCausal(true)).toEqual({ ok: false, error: "mfa_required" });
    expect(deps.rpc).not.toHaveBeenCalled();
  });

  it("ativa e desativa somente a organização autenticada, com auditoria", async () => {
    expect(await definirLeadSubmittedCausal(true)).toEqual({ ok: true });
    expect(deps.rpc).toHaveBeenCalledWith("fn_definir_meta_lead_birth", {
      p_org: ORG_A,
      p_enabled: true,
    });
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversions.meta_lead_birth_updated",
        organizationId: ORG_A,
        metadata: { enabled: true },
      }),
    );

    deps.org.mockResolvedValueOnce({ orgId: ORG_B, role: "admin" });
    expect(await definirLeadSubmittedCausal(false)).toEqual({ ok: true });
    expect(deps.rpc).toHaveBeenLastCalledWith("fn_definir_meta_lead_birth", {
      p_org: ORG_B,
      p_enabled: false,
    });
    expect(deps.revalidate).toHaveBeenCalledWith("/app/settings/conversoes");
  });

  it("falha do banco não declara ativação nem audita", async () => {
    deps.rpc.mockResolvedValueOnce({ data: null, error: { message: "indisponível" } });
    expect(await definirLeadSubmittedCausal(true)).toEqual({ ok: false, error: "erro_ao_gravar" });
    expect(deps.audit).not.toHaveBeenCalled();
  });
});
