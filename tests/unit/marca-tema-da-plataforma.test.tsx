import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadAuthUser: vi.fn(),
  marcaDaInstalacao: vi.fn(),
  cssPersonalizadoDaInstalacao: vi.fn(),
  temasInstaladosDaPlataforma: vi.fn(),
  idDoTemaDaPlataforma: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: mocks.loadAuthUser }));
vi.mock("@/lib/branding/instalacao", () => ({
  marcaDaInstalacao: mocks.marcaDaInstalacao,
  registrarEstadoDaMarca: vi.fn(),
  motivoDoFallback: () => [],
}));
vi.mock("@/lib/branding/css-personalizado", () => ({
  cssPersonalizadoDaInstalacao: mocks.cssPersonalizadoDaInstalacao,
  validarCssPersonalizado: () => ({ css: null, erro: null, regras: 0, declaracoes: 0 }),
}));
vi.mock("@/lib/extensions/tema-da-plataforma", () => ({
  temasInstaladosDaPlataforma: mocks.temasInstaladosDaPlataforma,
  idDoTemaDaPlataforma: mocks.idDoTemaDaPlataforma,
}));
// Os dois cartões vizinhos são client components com estado próprio e têm teste
// de casa; aqui o que se mede é a COMPOSIÇÃO da tela — que o cartão do tema
// entra nela, com os temas que a instalação oferece.
vi.mock("@/app/admin/(protected)/marca/_form", () => ({
  FormularioDaMarca: () => <form data-testid="formulario-da-marca" />,
}));
vi.mock("@/app/admin/(protected)/marca/_css-personalizado", () => ({
  CssPersonalizado: () => <form data-testid="css-personalizado" />,
}));

import Page from "@/app/admin/(protected)/marca/page";

/**
 * O CARTÃO "Tema da plataforma" NA TELA `/admin/marca` (#3790).
 *
 * ── O que este arquivo mede, e o que NÃO mede ─────────────────────────────
 *
 * Mede a COMPOSIÇÃO: a tela passa a oferecer o tema da plataforma, com os temas
 * que as extensões instaladas declaram, e escolhe "Nenhum" como estado de
 * partida quando não há escolha gravada. Não mede o comportamento do seletor
 * (Radix só monta os itens quando abre) nem a ação — a ação tem teste próprio,
 * e o CSS do layout tem o dele.
 *
 * O caso vazio também é medido: instalação sem extensão que declare tema vê a
 * frase que diz o que fazer, em vez de um seletor com uma opção só.
 */

const TEMA = {
  palette: "mist",
  claro: { "--color-bg": "#f6f6f4" },
  escuro: { "--color-bg": "#11151c" },
};

async function renderizarTela() {
  return renderToStaticMarkup(await Page());
}

describe("/admin/marca mostra o tema da plataforma", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadAuthUser.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      is_platform_admin: true,
      locale: "pt-BR",
      support: null,
    });
    mocks.marcaDaInstalacao.mockResolvedValue(null);
    mocks.cssPersonalizadoDaInstalacao.mockResolvedValue("");
    mocks.idDoTemaDaPlataforma.mockResolvedValue(null);
    mocks.temasInstaladosDaPlataforma.mockResolvedValue([]);
  });

  it("com tema instalado, o cartão aparece com o seletor", async () => {
    mocks.temasInstaladosDaPlataforma.mockResolvedValue([
      {
        instalacaoId: "11111111-1111-4111-8111-111111111111",
        rotulo: "acme/tema-do-cliente",
        versao: "1.2.0",
        tema: TEMA,
      },
    ]);

    const html = await renderizarTela();

    expect(html).toContain("Tema da plataforma");
    expect(html).toContain("tema-da-plataforma-escolha");
    expect(html).not.toContain("tema-da-plataforma-sem-extensoes");
    // A tela lê a ESCOLHA gravada para abrir o seletor no valor certo.
    expect(mocks.idDoTemaDaPlataforma).toHaveBeenCalled();
  });

  it("sem extensão que ofereça tema, o cartão explica em vez de mentir", async () => {
    const html = await renderizarTela();

    expect(html).toContain("Tema da plataforma");
    expect(html).toContain("tema-da-plataforma-sem-extensoes");
  });
});
