/** Porta real da action; providers e DNS substituídos só neste teste unitário. */
import { beforeEach, describe, expect, it, vi } from "vitest";
const { conferirNoDns, carregar, oficial, admin, loggerError } = vi.hoisted(() => ({
  conferirNoDns: vi.fn(),
  carregar: vi.fn(),
  oficial: vi.fn(),
  admin: vi.fn(),
  loggerError: vi.fn(),
}));
vi.mock("@/lib/email/dominio-de-envio-dns", () => ({ conferirDominioDeEnvio: conferirNoDns }));
vi.mock("@/lib/email/resend-da-organizacao", () => ({
  carregarContaResend: carregar,
  dominioOficialDaContaResend: oficial,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: admin }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  mfaEmDivida: vi.fn(),
}));
vi.mock("@/lib/auth/pode-administrar-empresa", () => ({ podeAdministrarEmpresa: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: loggerError } }));
import { conferirDominioDeEnvio } from "@/app/actions/settings/conferirDominioDeEnvio";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { supportWriteError } from "@/lib/impersonate/support";
import { dominioOficial } from "@/tests/fixtures/email-dominio-oficial";
const CONTA = { apiKey: "re_fixture_apenas_unit", fromEmail: "contato@lojadaana.com" };
const DOMINIO = dominioOficial();
const DIAGNOSTICO = {
  dominio: "lojadaana.com",
  registros: [],
  bloqueios: [],
  avisos: [],
  estadoNaResend: "verified",
  envioHabilitado: true,
  conferidoEm: "2026-10-26T12:00:00Z",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadAuthUser).mockResolvedValue({ id: "user-1", support: null } as never);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: "org-1", role: "admin" } as never);
  vi.mocked(podeAdministrarEmpresa).mockReturnValue(true);
  vi.mocked(mfaEmDivida).mockResolvedValue(false);
  vi.mocked(supportWriteError).mockReturnValue(null);
  admin.mockReturnValue({ fixture: "admin" });
  carregar.mockResolvedValue(CONTA);
  oficial.mockResolvedValue({ ok: true, dominio: DOMINIO });
  conferirNoDns.mockResolvedValue({ ok: true, diagnostico: DIAGNOSTICO });
});
describe("as portas vêm antes de credencial, provedor e DNS", () => {
  it.each(["sessao", "suporte", "tenant", "papel", "mfa"] as const)("barra %s sem efeito", async (porta) => {
    if (porta === "sessao") vi.mocked(loadAuthUser).mockResolvedValue(null as never);
    if (porta === "suporte") vi.mocked(supportWriteError).mockReturnValue({ ok: false } as never);
    if (porta === "tenant") vi.mocked(resolveActiveOrg).mockResolvedValue(null as never);
    if (porta === "papel") vi.mocked(podeAdministrarEmpresa).mockReturnValue(false);
    if (porta === "mfa") vi.mocked(mfaEmDivida).mockResolvedValue(true);
    const error = {
      sessao: "unauthenticated",
      suporte: "forbidden_role",
      tenant: "forbidden_tenant",
      papel: "forbidden_role",
      mfa: "mfa_required",
    }[porta];
    expect(await conferirDominioDeEnvio()).toEqual({ ok: false, error });
    expect(admin).not.toHaveBeenCalled();
    expect(carregar).not.toHaveBeenCalled();
    expect(oficial).not.toHaveBeenCalled();
    expect(conferirNoDns).not.toHaveBeenCalled();
    if (porta === "papel") expect(mfaEmDivida).not.toHaveBeenCalled();
  });
});
describe("a conta do tenant determina o domínio", () => {
  it("argumentos extras não escolhem domínio nem organização", async () => {
    const r = await Reflect.apply(conferirDominioDeEnvio, undefined, [
      "servidor.interno",
      "org-invasora",
    ]);
    expect(carregar).toHaveBeenCalledWith({ fixture: "admin" }, "org-1");
    expect(oficial).toHaveBeenCalledWith(CONTA);
    expect(conferirNoDns).toHaveBeenCalledWith(DOMINIO);
    expect(r).toEqual({ ok: true, diagnostico: DIAGNOSTICO });
    expect(JSON.stringify(r)).not.toContain(CONTA.apiKey);
  });
  it("ausência de conta não consulta provider nem DNS", async () => {
    carregar.mockResolvedValue(null);
    expect(await conferirDominioDeEnvio()).toEqual({ ok: false, error: "conta_nao_conectada" });
    expect(oficial).not.toHaveBeenCalled();
    expect(conferirNoDns).not.toHaveBeenCalled();
  });
  it("conta ilegível é falha, sem consultar como se não estivesse configurada", async () => {
    carregar.mockRejectedValue(new Error(CONTA.apiKey));
    const r = await conferirDominioDeEnvio();
    expect(r).toEqual({ ok: false, error: "conta_indisponivel" });
    expect(oficial).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain(CONTA.apiKey);
  });
  it("recusa oficial permanece nomeada e não faz DNS", async () => {
    oficial.mockResolvedValue({ ok: false, motivo: "permissao_insuficiente" });
    expect(await conferirDominioDeEnvio()).toEqual({ ok: false, error: "permissao_insuficiente" });
    expect(conferirNoDns).not.toHaveBeenCalled();
  });
  it("domínio inválido é recusa da camada própria", async () => {
    conferirNoDns.mockResolvedValue({
      ok: false,
      motivo: "dominio_invalido",
      bloqueios: ["domínio inválido"],
    });
    expect(await conferirDominioDeEnvio()).toEqual({ ok: false, error: "dominio_invalido" });
  });
  it("exceção inesperada vira recusa sem logar a mensagem do transporte", async () => {
    conferirNoDns.mockRejectedValue(new Error(CONTA.apiKey));
    expect(await conferirDominioDeEnvio()).toEqual({ ok: false, error: "consulta_indisponivel" });
    expect(loggerError).toHaveBeenCalled();
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(CONTA.apiKey);
  });
});
