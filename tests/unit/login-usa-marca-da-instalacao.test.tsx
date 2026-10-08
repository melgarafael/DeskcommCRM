import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  marcaDaSaida: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: mocks.marcaDaSaida }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/i18n/idiomaAnonimo", () => ({ idiomaDoVisitante: vi.fn(async () => "pt-BR") }));
vi.mock("@/lib/i18n/dicionario", () => ({ traduzir: (texto: string) => texto }));
vi.mock("@/components/auth/LoginForm", () => ({ LoginForm: () => null }));
vi.mock("@/components/auth/EntrarComGoogle", () => ({ EntrarComGoogle: () => null }));

describe("marca da instalação na tela de login", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.marcaDaSaida.mockReset();
    mocks.createClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
    });
  });

  it("mostra o nome configurado na instalação, não o valor antigo do ambiente", async () => {
    mocks.marcaDaSaida.mockResolvedValue({ nome: "Marca definida no painel" });
    const { default: LoginPage } = await import("@/app/(public)/login/page");

    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));

    expect(mocks.marcaDaSaida).toHaveBeenCalledWith(null);
    expect(html).toContain(">Marca definida no painel</p>");
  });
});
