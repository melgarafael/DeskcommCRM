/**
 * O TOPO CABE EM 320px — a regra, não o pixel.
 *
 * Medido na prova pela tela do #5089 (21/11, sem módulo conectado): em 320px a
 * coluna da busca (`header[data-casca=topo]`) encolhia a 0px e o botão Buscar
 * (42px, só a lupa) passava 13px por cima do seletor de organização e 13px por
 * cima do sino. Em 360px a conta já fechava com 1px de folga de cada lado.
 *
 * A conta, com os números de hoje: 24px de padding + 92px do grupo da esquerda
 * (menu 44 + vão 8 + seletor 40) + 200px do grupo da direita (sino 44 + vão 8 +
 * idioma 44 + vão 8 + tema 44 + vão 8 + avatar 44) + 16px de vãos = 332px. Em
 * 320px sobram -12px para a busca; em 360px sobram 28px, e os 42px do botão
 * cabem porque os vizinhos têm 1px de margem.
 *
 * O conserto tem duas metades, e é por isso que este teste olha duas classes:
 *  - a busca ganha PISO de largura abaixo de 360px (`max-[359px]:min-w-11`),
 *    então a coluna nunca volta a 0px nem que apareça outro controle;
 *  - o tema sai do topo abaixo de 360px (`max-[359px]:hidden`), que é o que
 *    libera os 52px necessários. Os dois cortes são `max-[359px]` de propósito:
 *    em 360px o desenho de hoje continua pixel a pixel igual.
 *
 * O jsdom não faz layout — ele devolve retângulo zero para todo mundo e um
 * `getBoundingClientRect` aqui não provaria nada. Então o teste prova a REGRA
 * (quem carrega qual classe, e que ela é escopada) e o que não pode se perder
 * junto: o nome da organização e o nome do botão de busca continuam na árvore
 * de acessibilidade. A prova de pixel é a medição de bancada por
 * `getBoundingClientRect` em viewport emulado, registrada no corpo do PR.
 */
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({
    organizations: [
      { organization_id: "a", organization_name: "Studio Mariana Castro" },
      { organization_id: "b", organization_name: "Outra" },
    ],
    is_platform_admin: false,
    support: null,
    full_name: "Mariana Castro",
    email: "mariana@exemplo.com",
    avatar_url: null,
  }),
  useActiveOrg: () => ({ orgId: "a", name: "Studio Mariana Castro" }),
  useAuth: () => ({ signOut: vi.fn() }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("./OrganizationTransitionProvider", () => ({
  useOrganizationTransition: () => ({ begin: vi.fn(), cancel: vi.fn() }),
}));
vi.mock("@/app/actions/shell/setActiveOrg", () => ({ setActiveOrg: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/i18n/IdiomaProvider", () => ({
  useIdioma: () => "pt",
  useAplicarIdioma: () => vi.fn(),
}));
vi.mock("@/lib/theme", () => ({
  useTheme: () => ({ theme: "light", setTheme: vi.fn() }),
}));
vi.mock("react-hotkeys-hook", () => ({ useHotkeys: vi.fn() }));
vi.mock("@/components/shell/CommandPalette", () => ({ CommandPalette: () => null }));
// O seletor de idioma é vizinho do tema no menu do usuário; o que este arquivo
// mede é o ESPAÇO que ele ocupa, então ele entra como a marca de 44px que é.
vi.mock("./SeletorDeIdioma", () => ({
  SeletorDeIdioma: () => (
    <button type="button" data-testid="seletor-de-idioma" className="h-11 w-11">
      PT
    </button>
  ),
}));
vi.mock("./MobileSidebar", () => ({
  MobileSidebar: () => (
    <button type="button" data-testid="menu-lateral" className="h-11 w-11">
      menu
    </button>
  ),
}));
// O sino e o cartão de proposta leem React Query; o que interessa aqui é a
// largura fixa que eles ocupam no grupo da direita.
vi.mock("./AlertsBell", () => ({
  AlertsBell: () => (
    <a
      href="/app/ai/inbox"
      data-testid="alerts-bell"
      aria-label="Central de avisos"
      className="h-11 w-11"
    >
      sino
    </a>
  ),
}));
vi.mock("./AvisoDePropostaEmDestaque", () => ({ AvisoDePropostaEmDestaque: () => null }));
vi.mock("@/components/modulo/PainelDoModulo", () => ({
  PainelDoModuloProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  BotaoDoPainelDoModulo: () => null,
}));

import { TopBar } from "./TopBar";

function classes(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

describe("o topo do celular em 320px", () => {
  it("a coluna da busca tem piso de 44px abaixo de 360px — e nada muda de 360 para cima", () => {
    render(<TopBar />);
    const grupo = screen.getByTestId("topo-busca");
    const c = classes(grupo);

    // `min-w-11` = 2.75rem = 44px: maior que os 42px do botão Buscar. É o que
    // impede a coluna de voltar a 0px.
    expect(c).toContain("max-[359px]:min-w-11");
    // Se o piso virar `min-w-11` sem o escopo, ele passa a valer em 360px
    // também — onde hoje a coluna tem 28px — e o botão volta a sobrepor o
    // seletor de organização. Por isso o caso cobra o escopo, não só o piso.
    expect(c).not.toContain("min-w-11");
    // As classes que desenham a busca de 360px para cima continuam intactas.
    expect(c).toContain("flex-1");
    expect(c).toContain("min-w-0");
    expect(c).toContain("md:max-w-md");
  });

  it("o tema sai do topo só abaixo de 360px, e é o que abre espaço para a busca", () => {
    render(<TopBar />);
    const tema = screen.getByRole("button", { name: /^Tema:/ });
    const c = classes(tema);

    expect(c).toContain("max-[359px]:hidden");
    // `hidden` sem escopo, ou `sm:hidden`, apagaria o tema em 360px — onde ele
    // cabe e a issue manda preservar.
    expect(c).not.toContain("hidden");
    expect(c).not.toContain("sm:hidden");
  });

  it("o grupo da direita é `shrink-0` e não cresce sobre a busca", () => {
    render(<TopBar />);
    const sino = screen.getByTestId("alerts-bell");
    const grupoDaDireita = sino.parentElement as HTMLElement;
    const c = classes(grupoDaDireita);

    expect(c).toContain("shrink-0");
    expect(c).not.toContain("flex-1");
  });

  it("o nome da organização continua acessível — o botão inteiro não é escondido", () => {
    render(<TopBar />);
    const seletor = screen.getByTestId("tenant-switcher");
    // O que fica escondido abaixo de `md` é o TEXTO do nome (`hidden md:inline`),
    // com o nome no `aria-label`. O botão em si — o alvo de toque — continua.
    expect(seletor.getAttribute("aria-label")).toContain("Studio Mariana Castro");
    expect(classes(seletor)).not.toContain("hidden");
    const rotulo = seletor.querySelector("span");
    expect(rotulo?.textContent).toBe("Studio Mariana Castro");
    expect(classes(rotulo as Element)).toEqual(expect.arrayContaining(["hidden", "md:inline"]));
  });

  it("o botão Buscar continua com nome acessível", () => {
    render(<TopBar />);
    const busca = screen.getByRole("button", { name: /Buscar\.\.\./ });
    expect(within(busca).getByText("Buscar...")).toBeTruthy();
  });

  it("a chave da medição da issue continua no header", () => {
    render(<TopBar />);
    const header = document.querySelector("header[data-casca='topo']");
    expect(header).not.toBeNull();
  });
});
