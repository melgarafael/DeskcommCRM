import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  rpc: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: mocks.loadAuthUser,
  resolveActiveOrg: mocks.resolveActiveOrg,
}));
vi.mock("@/lib/impersonate/support", () => ({
  supportWriteError: (s: unknown) => (s ? "somente_leitura" : null),
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: mocks.rpc }) }));

import { definirAparenciaDaOrganizacao } from "./definirAparenciaDaOrganizacao";

const USER = { id: "00000000-0000-4000-8000-000000000001", support: null };
const ORG_DA_SESSAO = "11111111-1111-4111-8111-111111111111";

const PADRAO = {
  template: null,
  fonte: null,
  raio: null,
  densidade: "confortavel",
  efeitos: "completo",
  cor_secundaria: null,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadAuthUser.mockResolvedValue(USER);
  mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG_DA_SESSAO, role: "admin" });
  mocks.rpc.mockResolvedValue({ data: { aparencia: { template: "aurora" }, mudou: true }, error: null });
});

describe("definirAparenciaDaOrganizacao", () => {
  it("grava na organização DA SESSÃO, só com o que difere do padrão", async () => {
    const r = await definirAparenciaDaOrganizacao({ ...PADRAO, template: "aurora", cor_secundaria: "#7C3AED" });
    expect(r).toEqual({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledWith("fn_definir_aparencia_da_organizacao", {
      p_org: ORG_DA_SESSAO,
      p_aparencia: { template: "aurora", cor_secundaria: "#7c3aed" },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app", "layout");
  });

  it("tudo no padrão apaga a chave (null), e a organização volta à aparência de fábrica", async () => {
    await definirAparenciaDaOrganizacao(PADRAO);
    expect(mocks.rpc).toHaveBeenCalledWith("fn_definir_aparencia_da_organizacao", {
      p_org: ORG_DA_SESSAO,
      p_aparencia: null,
    });
  });

  it("template fora do catálogo é recusado antes de chegar ao banco", async () => {
    const r = await definirAparenciaDaOrganizacao({ ...PADRAO, template: "nao-existe" } as never);
    expect(r).toEqual({ ok: false, erro: "invalido" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("cor secundária que não é hex é recusada antes de chegar ao banco", async () => {
    const r = await definirAparenciaDaOrganizacao({ ...PADRAO, cor_secundaria: "red;}" } as never);
    expect(r).toEqual({ ok: false, erro: "invalido" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("quem não é admin nem chama o banco", async () => {
    mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG_DA_SESSAO, role: "manager" });
    const r = await definirAparenciaDaOrganizacao({ ...PADRAO, template: "aurora" });
    expect(r).toEqual({ ok: false, erro: "sem_permissao" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("modo suporte (somente leitura) não grava", async () => {
    mocks.loadAuthUser.mockResolvedValue({ ...USER, support: { mode: "read" } });
    const r = await definirAparenciaDaOrganizacao({ ...PADRAO, template: "aurora" });
    expect(r).toEqual({ ok: false, erro: "somente_leitura" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("a recusa de segundo fator do banco vira o código `mfa`", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "aparencia_da_organizacao_mfa_required" },
    });
    const r = await definirAparenciaDaOrganizacao({ ...PADRAO, template: "aurora" });
    expect(r).toEqual({ ok: false, erro: "mfa" });
  });

  it("audita só quando o banco diz que mudou", async () => {
    await definirAparenciaDaOrganizacao({ ...PADRAO, template: "aurora" });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "org.aparencia_updated",
        organizationId: ORG_DA_SESSAO,
        resourceId: ORG_DA_SESSAO,
        actorUserId: USER.id,
      }),
    );

    mocks.audit.mockClear();
    mocks.rpc.mockResolvedValue({ data: { aparencia: { template: "aurora" }, mudou: false }, error: null });
    await definirAparenciaDaOrganizacao({ ...PADRAO, template: "aurora" });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
