import { beforeEach, expect, it, vi } from "vitest";
import { carregarMidiaGoogle } from "./actions";

const m = vi.hoisted(() => ({
  papel: vi.fn(), admin: vi.fn(), conexao: vi.fn(), configurado: vi.fn(), campanhas: vi.fn(),
}));
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
  expect(resultado).toMatchObject({ ok: false, detalhe: expect.stringContaining("GOOGLE_ADS_DEVELOPER_TOKEN") });
  expect(m.conexao).toHaveBeenCalledWith(m.admin.mock.results[0]?.value, "org-teste");
  expect(m.campanhas).not.toHaveBeenCalled();
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
