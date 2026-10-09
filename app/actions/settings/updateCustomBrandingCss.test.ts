import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  headers: vi.fn(),
  loadAuthUser: vi.fn(),
  escritaDeAdminOuRecusa: vi.fn(),
  gravarPelaTela: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/auth/escritaDeAdminOuRecusa", () => ({
  escritaDeAdminOuRecusa: mocks.escritaDeAdminOuRecusa,
}));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: mocks.loadAuthUser }));
vi.mock("@/lib/instalacao/config", () => ({ gravarPelaTela: mocks.gravarPelaTela }));

import { updateCustomBrandingCss } from "./updateCustomBrandingCss";

const ADMIN = { id: "00000000-0000-4000-8000-000000000001" };
const CSS = ".text-muted-foreground { color: #52645a; }";

describe("updateCustomBrandingCss", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headers.mockResolvedValue(new Headers({ "x-request-id": "req-test" }));
    mocks.escritaDeAdminOuRecusa.mockResolvedValue({
      ok: true,
      ctx: { user: ADMIN, platformAdmin: { scope: "full" } },
    });
    mocks.loadAuthUser.mockResolvedValue({ support: null });
    mocks.gravarPelaTela.mockResolvedValue({ ok: true });
  });

  it("recusa entrada que não é texto sem gravar", async () => {
    const resultado = await updateCustomBrandingCss({ css: CSS } as never);

    expect(resultado.ok).toBe(false);
    expect(mocks.gravarPelaTela).not.toHaveBeenCalled();
  });

  it("quem não pode gravar recebe a recusa, não a mensagem do validador", async () => {
    mocks.escritaDeAdminOuRecusa.mockResolvedValue({ ok: false, error: "forbidden" });

    for (const entrada of ["body { color: red; }", { css: CSS } as never]) {
      expect(await updateCustomBrandingCss(entrada)).toEqual({
        ok: false,
        error: "Esta ação exige acesso completo à instalação.",
      });
    }
    expect(mocks.gravarPelaTela).not.toHaveBeenCalled();
  });

  it("recusa escopo de plataforma insuficiente", async () => {
    mocks.escritaDeAdminOuRecusa.mockResolvedValue({ ok: false, error: "forbidden_scope" });

    const resultado = await updateCustomBrandingCss(CSS);

    expect(resultado).toEqual({ ok: false, error: "Esta ação exige acesso completo à instalação." });
    expect(mocks.loadAuthUser).not.toHaveBeenCalled();
    expect(mocks.gravarPelaTela).not.toHaveBeenCalled();
  });

  it("recusa sessão com dívida de verificação em duas etapas", async () => {
    mocks.escritaDeAdminOuRecusa.mockResolvedValue({ ok: false, error: "mfa_required" });

    const resultado = await updateCustomBrandingCss(CSS);

    expect(resultado).toEqual({ ok: false, error: "Confirme a verificação em duas etapas." });
    expect(mocks.gravarPelaTela).not.toHaveBeenCalled();
  });

  it("recusa alteração durante acompanhamento administrativo", async () => {
    mocks.loadAuthUser.mockResolvedValue({ support: { status: "active" } });

    const resultado = await updateCustomBrandingCss(CSS);

    expect(resultado.ok).toBe(false);
    expect(mocks.gravarPelaTela).not.toHaveBeenCalled();
  });

  it("grava a folha validada e audita apenas metadados, não o CSS", async () => {
    const resultado = await updateCustomBrandingCss(CSS);

    expect(resultado).toEqual({ ok: true });
    expect(mocks.gravarPelaTela).toHaveBeenCalledWith("APP_CUSTOM_CSS", CSS, {
      ehSegredo: false,
      ator: ADMIN.id,
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "platform_branding.updated",
        metadata: expect.objectContaining({ fields_changed: ["custom_css"], css_rules: 1 }),
      }),
    );
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(CSS);
  });
});
