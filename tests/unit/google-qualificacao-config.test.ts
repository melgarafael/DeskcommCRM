import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateGoogleAdsConnection } from "@/app/actions/settings/updateGoogleAdsConnection";

const mock = vi.hoisted(() => ({
  user: vi.fn(),
  org: vi.fn(),
  mfa: vi.fn(),
  support: vi.fn(),
  admin: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: mock.user,
  resolveActiveOrg: mock.org,
  mfaEmDivida: mock.mfa,
}));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: mock.support }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mock.admin }));
vi.mock("@/lib/audit", () => ({ audit: mock.audit }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
const ETAPA = "11111111-1111-4111-8111-111111111111";
const input = {
  customer_id: "1234567890",
  conversion_action_id: "11",
  enabled: true,
  qualification: { stage_id: ETAPA, action_id: "42" },
};
let etapa: { id: string } | null;
let patches: Record<string, unknown>[];
let filtros: Array<[string, unknown]>;
beforeEach(() => {
  vi.clearAllMocks();
  etapa = { id: ETAPA };
  patches = [];
  filtros = [];
  mock.user.mockResolvedValue({ id: "u", is_platform_admin: false });
  mock.org.mockResolvedValue({ orgId: "org-autenticada", role: "admin" });
  mock.support.mockReturnValue(false);
  mock.mfa.mockResolvedValue(false);
  mock.admin.mockReturnValue({
    from: () => {
      let mutacao = false;
      const q = {
        update: (v: Record<string, unknown>) => {
          patches.push(v);
          mutacao = true;
          return q;
        },
        eq: (k: string, v: unknown) => {
          filtros.push([k, v]);
          return q;
        },
        select: () => (mutacao ? Promise.resolve({ data: [{ id: "conexao" }], error: null }) : q),
        maybeSingle: async () => ({ data: etapa, error: null }),
      };
      return q;
    },
  });
});
describe("configuração de qualificação", () => {
  it("valida etapa aberta na organização autenticada e audita a configuração", async () => {
    expect(await updateGoogleAdsConnection(input)).toEqual({ ok: true });
    expect(filtros).toContainEqual(["organization_id", "org-autenticada"]);
    expect(filtros).toContainEqual(["is_won", false]);
    expect(filtros).toContainEqual(["is_lost", false]);
    expect(patches[0]).toMatchObject({
      google_qualification_stage_id: ETAPA,
      google_qualification_action_id: "42",
    });
    expect(mock.audit).toHaveBeenCalledOnce();
  });
  it("não escreve quando a etapa não é visível na organização", async () => {
    etapa = null;
    expect(await updateGoogleAdsConnection(input)).toMatchObject({ error: "validation_failed" });
    expect(patches).toHaveLength(0);
  });
  it("não mistura qualificação e compra na mesma ação", async () => {
    expect(
      await updateGoogleAdsConnection({
        ...input,
        qualification: { stage_id: ETAPA, action_id: "11" },
      }),
    ).toMatchObject({ error: "validation_failed" });
    expect(patches).toHaveLength(0);
  });
  it.each(["agent", "viewer", "manager"])("papel %s não altera a regra", async (role) => {
    mock.org.mockResolvedValue({ orgId: "org-autenticada", role });
    expect(await updateGoogleAdsConnection(input)).toMatchObject({ error: "forbidden_role" });
    expect(mock.admin).not.toHaveBeenCalled();
  });
  it("suporte somente leitura e MFA pendente bloqueiam a escrita", async () => {
    mock.support.mockReturnValue(true);
    expect(await updateGoogleAdsConnection(input)).toMatchObject({ error: "forbidden_role" });
    mock.support.mockReturnValue(false);
    mock.mfa.mockResolvedValue(true);
    expect(await updateGoogleAdsConnection(input)).toMatchObject({ error: "mfa_required" });
    expect(patches).toHaveLength(0);
  });
  it("desliga explicitamente a qualificação sem apagar a conexão", async () => {
    expect(
      await updateGoogleAdsConnection({
        ...input,
        qualification: { stage_id: null, action_id: null },
      }),
    ).toEqual({ ok: true });
    expect(patches[0]).toMatchObject({
      google_qualification_stage_id: null,
      google_qualification_action_id: null,
    });
  });
  it("cliente antigo que não manda regra não a apaga", async () => {
    const { qualification: _qualification, ...antigo } = input;
    expect(await updateGoogleAdsConnection(antigo)).toEqual({ ok: true });
    expect(patches[0]).not.toHaveProperty("google_qualification_stage_id");
  });
});
