import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  org: vi.fn(),
  pode: vi.fn(),
  mfa: vi.fn(),
  support: vi.fn(),
  conexao: vi.fn(),
  criar: vi.fn(),
  listar: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: mocks.user,
  resolveActiveOrg: mocks.org,
  mfaEmDivida: mocks.mfa,
}));
vi.mock("@/lib/auth/pode-administrar-empresa", () => ({ podeAdministrarEmpresa: mocks.pode }));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: mocks.support }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => "admin-client" }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/http/ip-do-cliente", () => ({ ipDoCliente: () => null }));
vi.mock("@/lib/plataformas-de-anuncio/google/api-google-ads", () => ({
  lerConexaoNativaParaDestinoGoogle: mocks.conexao,
  criarAcaoDeConversao: mocks.criar,
  listarAcoesDeConversao: mocks.listar,
}));

import { criarAcaoDeConversaoGoogle, listarAcoesDeConversaoGoogle } from "./acoesDeConversaoGoogle";

const pedido = { nome: "Contato", categoria: "CONTACT" as const, incluir_em_conversoes: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: "ator" });
  mocks.org.mockResolvedValue({ orgId: "org-da-sessao" });
  mocks.pode.mockReturnValue(true);
  mocks.mfa.mockResolvedValue(false);
  mocks.support.mockReturnValue(null);
  mocks.conexao.mockImplementation(async (_admin, _org, destino) => ({
    ok: true,
    dados: {
      refreshToken: "nativo",
      customerId: destino?.customerId ?? "1234567890",
      loginCustomerId: destino?.loginCustomerId ?? null,
    },
  }));
  mocks.criar.mockResolvedValue({ ok: true, dados: { id: "77", nome: "Contato #xyz" } });
  mocks.listar.mockResolvedValue({ ok: true, dados: [] });
});

describe("destino das ações de conversão", () => {
  it("cria e audita na conta escolhida, com MCC null explícito e organização da sessão", async () => {
    expect(
      await criarAcaoDeConversaoGoogle({
        ...pedido,
        google_customer_id: "111-222-3333",
        google_login_customer_id: null,
      }),
    ).toMatchObject({ ok: true });
    expect(mocks.conexao).toHaveBeenCalledWith("admin-client", "org-da-sessao", {
      customerId: "1112223333",
      loginCustomerId: null,
    });
    expect(mocks.criar).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshToken: "nativo",
        customerId: "1112223333",
        loginCustomerId: null,
      }),
      expect.anything(),
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-da-sessao",
        metadata: expect.objectContaining({ google_customer_id: "1112223333" }),
      }),
    );
  });

  it("lista no mesmo destino e preserva a conta global quando não há seleção", async () => {
    await listarAcoesDeConversaoGoogle({
      google_customer_id: "1112223333",
      google_login_customer_id: "9998887776",
    });
    expect(mocks.conexao).toHaveBeenLastCalledWith("admin-client", "org-da-sessao", {
      customerId: "1112223333",
      loginCustomerId: "9998887776",
    });
    await criarAcaoDeConversaoGoogle(pedido);
    expect(mocks.conexao).toHaveBeenLastCalledWith("admin-client", "org-da-sessao", undefined);
  });

  it.each([
    { google_customer_id: "outro-1234567890" },
    { google_customer_id: null, google_login_customer_id: "9998887776" },
  ])("recusa identificadores inválidos antes de acessar a credencial (%j)", async (destino) => {
    expect(await criarAcaoDeConversaoGoogle({ ...pedido, ...destino })).toMatchObject({
      ok: false,
      error: "validation_failed",
    });
    expect(mocks.conexao).not.toHaveBeenCalled();
    expect(mocks.criar).not.toHaveBeenCalled();
  });

  it("um ator sem papel não consegue usar o destino para alcançar a credencial", async () => {
    mocks.pode.mockReturnValue(false);
    expect(
      await criarAcaoDeConversaoGoogle({ ...pedido, google_customer_id: "1112223333" }),
    ).toMatchObject({ ok: false, error: "forbidden_role" });
    expect(mocks.conexao).not.toHaveBeenCalled();
    expect(mocks.criar).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
