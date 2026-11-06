import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  headers: vi.fn(),
  loadAuthUser: vi.fn(),
  escritaDeAdminOuRecusa: vi.fn(),
  gravarPelaTela: vi.fn(),
  voltarAoAmbiente: vi.fn(),
  conferirTemaDaPlataforma: vi.fn(),
  invalidarTemaDaPlataforma: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/auth/escritaDeAdminOuRecusa", () => ({
  escritaDeAdminOuRecusa: mocks.escritaDeAdminOuRecusa,
}));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: mocks.loadAuthUser }));
vi.mock("@/lib/instalacao/config", () => ({
  gravarPelaTela: mocks.gravarPelaTela,
  voltarAoAmbiente: mocks.voltarAoAmbiente,
}));
vi.mock("@/lib/extensions/tema-da-plataforma", () => ({
  CHAVE_TEMA_DA_PLATAFORMA: "APP_TEMA_DA_PLATAFORMA",
  conferirTemaDaPlataforma: mocks.conferirTemaDaPlataforma,
  invalidarTemaDaPlataforma: mocks.invalidarTemaDaPlataforma,
}));

import { updatePlatformTheme } from "./updatePlatformTheme";

/**
 * A AÇÃO do cartão "Tema da plataforma" (#3790).
 *
 * ── O que ela precisa garantir ────────────────────────────────────────────
 *
 * A tela oferece uma lista fechada, mas o payload é do cliente. Então a ação
 * confere no BANCO que a instalação existe e traz tema válido — mesma lição das
 * guardas do CSS personalizado (`updateCustomBrandingCss`), e as MESMAS guardas
 * de papel: escrita de admin de plataforma, sem dívida de MFA, fora do
 * acompanhamento administrativo.
 *
 * "Nenhum" APAGA a linha (`voltarAoAmbiente`), em vez de gravar string vazia:
 * o estado tem de voltar a ser indistinguível de "nunca usou", e é isso que
 * mantém a promessa "sem escolha, nada muda".
 *
 * A auditoria usa `platform_branding.updated` — a mesma superfície da marca — e
 * leva só metadados: a paleta, não o CSS.
 */

const ADMIN = { id: "00000000-0000-4000-8000-000000000001" };
const INSTALACAO = "11111111-1111-4111-8111-111111111111";
const TEMA = {
  palette: "mist" as const,
  claro: { "--color-bg": "#f6f6f4" },
  escuro: { "--color-bg": "#11151c" },
};

describe("updatePlatformTheme", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headers.mockResolvedValue(new Headers({ "x-request-id": "req-test" }));
    mocks.escritaDeAdminOuRecusa.mockResolvedValue({
      ok: true,
      ctx: { user: ADMIN, platformAdmin: { scope: "full" } },
    });
    mocks.loadAuthUser.mockResolvedValue({ support: null });
    mocks.gravarPelaTela.mockResolvedValue({ ok: true });
    mocks.voltarAoAmbiente.mockResolvedValue({ ok: true });
    mocks.conferirTemaDaPlataforma.mockResolvedValue({ ok: true, tema: TEMA });
  });

  it("quem não pode gravar recebe a recusa, não a mensagem do validador", async () => {
    mocks.escritaDeAdminOuRecusa.mockResolvedValue({ ok: false, error: "forbidden" });

    for (const entrada of [INSTALACAO, null, 42]) {
      expect(await updatePlatformTheme(entrada)).toEqual({
        ok: false,
        error: "Esta ação exige acesso completo à instalação.",
      });
    }
    expect(mocks.gravarPelaTela).not.toHaveBeenCalled();
    expect(mocks.voltarAoAmbiente).not.toHaveBeenCalled();
  });

  it("recusa sessão com dívida de verificação em duas etapas", async () => {
    mocks.escritaDeAdminOuRecusa.mockResolvedValue({ ok: false, error: "mfa_required" });

    expect(await updatePlatformTheme(INSTALACAO)).toEqual({
      ok: false,
      error: "Confirme a verificação em duas etapas.",
    });
  });

  it("recusa alteração durante acompanhamento administrativo", async () => {
    mocks.loadAuthUser.mockResolvedValue({ support: { status: "active" } });

    expect((await updatePlatformTheme(INSTALACAO)).ok).toBe(false);
    expect(mocks.gravarPelaTela).not.toHaveBeenCalled();
  });

  it("entrada que não é texto nem null não vira consulta ao banco", async () => {
    // `undefined` incluso de propósito: só `null` significa "Nenhum", e um
    // payload sem o campo não pode apagar a escolha da instalação.
    for (const entrada of [42, { id: INSTALACAO }, "", "x".repeat(201), undefined]) {
      expect((await updatePlatformTheme(entrada)).ok).toBe(false);
    }
    expect(mocks.conferirTemaDaPlataforma).not.toHaveBeenCalled();
    expect(mocks.gravarPelaTela).not.toHaveBeenCalled();
  });

  it("instalação que não existe no banco não é gravada", async () => {
    mocks.conferirTemaDaPlataforma.mockResolvedValue({ ok: false, motivo: "nao_instalada" });

    expect(await updatePlatformTheme(INSTALACAO)).toEqual({
      ok: false,
      error: "Essa extensão não está mais instalada nesta instalação.",
    });
    expect(mocks.gravarPelaTela).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("instalação sem tema válido não é gravada", async () => {
    mocks.conferirTemaDaPlataforma.mockResolvedValue({ ok: false, motivo: "sem_tema" });

    expect(await updatePlatformTheme(INSTALACAO)).toEqual({
      ok: false,
      error: "A extensão escolhida não oferece um tema válido.",
    });
    expect(mocks.gravarPelaTela).not.toHaveBeenCalled();
  });

  it("falha de banco na conferência pede nova tentativa, e não grava", async () => {
    mocks.conferirTemaDaPlataforma.mockResolvedValue({
      ok: false,
      motivo: "banco_indisponivel",
    });

    expect(await updatePlatformTheme(INSTALACAO)).toEqual({
      ok: false,
      error: "Não foi possível conferir a extensão agora. Tente de novo.",
    });
    expect(mocks.gravarPelaTela).not.toHaveBeenCalled();
  });

  it("grava o ID da instalação, invalida o memo e audita a paleta", async () => {
    expect(await updatePlatformTheme(INSTALACAO)).toEqual({ ok: true });

    expect(mocks.conferirTemaDaPlataforma).toHaveBeenCalledWith(INSTALACAO);
    expect(mocks.gravarPelaTela).toHaveBeenCalledWith("APP_TEMA_DA_PLATAFORMA", INSTALACAO, {
      ehSegredo: false,
      ator: ADMIN.id,
    });
    expect(mocks.invalidarTemaDaPlataforma).toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "platform_branding.updated",
        metadata: expect.objectContaining({
          fields_changed: ["platform_theme"],
          platform_theme: INSTALACAO,
          platform_theme_palette: "mist",
        }),
      }),
    );
  });

  it('"Nenhum" APAGA a linha em vez de gravar vazio', async () => {
    expect(await updatePlatformTheme(null)).toEqual({ ok: true });

    expect(mocks.voltarAoAmbiente).toHaveBeenCalledWith("APP_TEMA_DA_PLATAFORMA");
    expect(mocks.gravarPelaTela).not.toHaveBeenCalled();
    expect(mocks.conferirTemaDaPlataforma).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ platform_theme: "nenhum" }),
      }),
    );
  });

  it("quando o banco recusa a escrita, a auditoria não registra um salvamento que não houve", async () => {
    mocks.gravarPelaTela.mockResolvedValue({ ok: false, motivo: "banco_recusou", detalhe: "x" });

    expect(await updatePlatformTheme(INSTALACAO)).toEqual({
      ok: false,
      error: "Não foi possível gravar o tema no banco da instalação.",
    });
    expect(mocks.invalidarTemaDaPlataforma).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
