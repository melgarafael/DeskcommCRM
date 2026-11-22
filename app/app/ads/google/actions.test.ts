import { beforeEach, expect, it, vi } from "vitest";
import { carregarMidiaGoogle, removerContaMidiaGoogle } from "./actions";

const m = vi.hoisted(() => ({
  papel: vi.fn(), admin: vi.fn(), conexao: vi.fn(), configurado: vi.fn(), campanhas: vi.fn(),
  conta: vi.fn(), audit: vi.fn(), revalidate: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidate }));
vi.mock("@/lib/audit", () => ({ audit: m.audit }));
vi.mock("@/lib/plataformas-de-anuncio/google/contas-de-relatorio", () => ({ lerContaDeRelatorio: m.conta }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: m.papel }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.admin }));
vi.mock("@/lib/plataformas-de-anuncio/google/config", () => ({ googleAdsEstaConfigurado: m.configurado }));
vi.mock("@/lib/plataformas-de-anuncio/google/api-google-ads", () => ({
  lerConexaoGoogleParaApi: m.conexao, lerCampanhas: m.campanhas,
}));

const janela = { de: "2026-09-01", ate: "2026-09-30" };
beforeEach(() => {
  vi.resetAllMocks();
  m.papel.mockResolvedValue({ ok: true, user: {}, org: { orgId: "org-teste", role: "manager" } });
  m.conexao.mockResolvedValue({ ok: true, dados: { customerId: "1111111111", refreshToken: "privado" } });
  m.configurado.mockReturnValue(true);
});

it("confere a permissão antes de acessar a credencial da organização", async () => {
  m.papel.mockResolvedValue({ ok: false });
  expect(await carregarMidiaGoogle(janela)).toMatchObject({ ok: false });
  expect(m.admin).not.toHaveBeenCalled();
  expect(m.campanhas).not.toHaveBeenCalled();
});

it("explica que faltam credenciais de relatório mesmo quando a conta já está conectada", async () => {
  m.configurado.mockReturnValue(false);
  const resultado = await carregarMidiaGoogle(janela);
  expect(resultado).toMatchObject({ ok: false, detalhe: expect.stringContaining("credenciais OAuth") });
  expect(m.configurado).toHaveBeenCalledWith("relatorio");
  expect(m.conexao).toHaveBeenCalledWith(m.admin.mock.results[0]?.value, "org-teste");
  expect(m.campanhas).not.toHaveBeenCalled();
});

it("consulta a conta escolhida dentro da organização e respeita sua recusa de acesso", async () => {
  const customerId = "2222222222";
  m.conta.mockResolvedValueOnce({ ok: false, falha: "sem_conexao", detalhe: "Conta indisponível." });
  expect(await carregarMidiaGoogle(janela, customerId)).toMatchObject({ ok: false });
  expect(m.conta).toHaveBeenCalledWith(m.admin.mock.results[0]?.value, "org-teste", customerId);
  expect(m.conexao).not.toHaveBeenCalled();
  expect(m.campanhas).not.toHaveBeenCalled();
  const conexao = { customerId, loginCustomerId: null, refreshToken: "teste" };
  m.conta.mockResolvedValueOnce({ ok: true, dados: conexao });
  m.campanhas.mockResolvedValueOnce({ ok: true, dados: [] });
  expect(await carregarMidiaGoogle(janela, customerId)).toEqual({ ok: true, contaId: customerId, campanhas: [] });
  expect(m.campanhas).toHaveBeenCalledWith(conexao, janela);
});

it("recusa identificador inválido antes de ler o banco", async () => {
  expect(await carregarMidiaGoogle(janela, "")).toMatchObject({ ok: false });
  expect(m.admin).not.toHaveBeenCalled();
});

it("somente o administrador pode retirar a conexão dedicada da própria organização", async () => {
  const id = "2222222222";
  expect(await removerContaMidiaGoogle(id)).toMatchObject({ ok: false });
  expect(m.admin).not.toHaveBeenCalled();
  m.papel.mockResolvedValue({ ok: true, user: { id: "operador" }, org: { orgId: "org-teste", role: "admin" } });
  const query = {
    delete: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: { customer_id: id }, error: null }),
  };
  const from = vi.fn().mockReturnValue(query);
  m.admin.mockReturnValue({ from });
  expect(await removerContaMidiaGoogle(id)).toEqual({ ok: true });
  expect(from.mock.calls).toEqual([["google_ads_reporting_accounts"]]);
  expect(query.eq.mock.calls).toEqual([["organization_id", "org-teste"], ["customer_id", id]]);
  expect(m.audit).toHaveBeenCalledOnce();
});

it.each([["manager", false], ["admin", true]])("só oferece a quem pode configurar o acesso ao Google (%s)", async (role, podeConfigurar) => {
  m.papel.mockResolvedValue({ ok: true, user: {}, org: { orgId: "org-teste", role } });
  m.campanhas.mockResolvedValue({ ok: false, detalhe: "Reautorize", falha: "reconectar" });
  expect(await carregarMidiaGoogle(janela)).toEqual({ ok: false, detalhe: "Reautorize", abrirConfiguracoes: podeConfigurar });
});

it.each([
  ["full", true],
  ["support_readonly", false],
  [null, false],
])("respeita o escopo %s do administrador da plataforma ao oferecer a configuração", async (scope, podeConfigurar) => {
  m.papel.mockResolvedValue({
    ok: true,
    user: { is_platform_admin: true, platform_admin_scope: scope, support: null },
    org: { orgId: "org-teste", role: "viewer" },
  });
  m.conexao.mockResolvedValue({ ok: false, falha: "sem_conexao", detalhe: "Conecte a conta" });
  expect(await carregarMidiaGoogle(janela)).toEqual({
    ok: false, detalhe: "Conecte a conta", abrirConfiguracoes: podeConfigurar,
  });
  expect(m.campanhas).not.toHaveBeenCalled();
});
