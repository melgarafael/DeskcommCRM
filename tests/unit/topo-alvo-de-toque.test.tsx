/**
 * O HAMBÚRGUER DO TOPO NUNCA FICA ABAIXO DE 44px — issue #5332.
 *
 * Em 320px o topo estoura 4px: 24px de padding + 92px do grupo da esquerda
 * (menu 44 + vão 8 + seletor 40) + 148px do grupo da direita (sino 44 + vão 8 +
 * idioma 44 + vão 8 + avatar 44, sem o tema, que sai abaixo de 360px) + 16px de
 * vãos = 280px, e a coluna da busca tem piso de 44px (`max-[359px]:min-w-11`,
 * #5096). Os 4px que faltam saíam do único item encolhível do grupo da esquerda:
 * o hambúrguer, que tinha `w-11` (44px) mas nenhum piso real — `width` em item
 * de flex é sugestão, e ele era comprimido a 40px de largura por 44px de altura.
 *
 * A bancada de caixa (Chromium, viewport 320/360/375/390, marcadores de 22px no
 * hambúrguer, 16px no seletor, 14px na busca) reproduz o defeito e a correção:
 *   antes ............... 320px: hambúrguer 40x44, seletor 40
 *   com `shrink-0` +
 *   `min-w-11` .......... 320px: hambúrguer 44x44, seletor 40, estouro 0,
 *                         busca 11px à esquerda do grupo da direita (igual ao
 *                         estado anterior — nenhuma sobreposição nova)
 *   de 360px para cima ... 44x44 nos dois estados, desenho intacto
 *
 * O jsdom não faz layout: `getBoundingClientRect` aqui devolve zero para todo
 * mundo. Então este arquivo prova a REGRA — quem carrega qual classe, e que a
 * altura não mudou — e o corpo do PR registra que o pixel em 320/375/390/1280
 * só a tela confirma.
 */
import { render, screen } from "@testing-library/react";
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
vi.mock("@/components/shell/OrganizationTransitionProvider", () => ({
  useOrganizationTransition: () => ({ begin: vi.fn(), cancel: vi.fn() }),
}));
vi.mock("@/app/actions/shell/setActiveOrg", () => ({ setActiveOrg: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/app",
}));
vi.mock("@/lib/i18n/IdiomaProvider", () => ({
  useIdioma: () => "pt",
  useAplicarIdioma: () => vi.fn(),
}));
vi.mock("@/lib/theme", () => ({
  useTheme: () => ({ theme: "light", setTheme: vi.fn() }),
}));
vi.mock("react-hotkeys-hook", () => ({ useHotkeys: vi.fn() }));
vi.mock("@/components/shell/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("@/components/shell/SeletorDeIdioma", () => ({
  SeletorDeIdioma: () => (
    <button type="button" data-testid="seletor-de-idioma" className="h-11 w-11">
      PT
    </button>
  ),
}));
vi.mock("@/components/shell/AlertsBell", () => ({
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
vi.mock("@/components/shell/AvisoDePropostaEmDestaque", () => ({
  AvisoDePropostaEmDestaque: () => null,
}));
vi.mock("@/components/modulo/PainelDoModulo", () => ({
  PainelDoModuloProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  BotaoDoPainelDoModulo: () => null,
}));

// O `MobileSidebar` NÃO é mockado: é justamente o botão dele que este arquivo
// mede. Mocká-lo aqui (como faz o teste do topo em 320px) trocaria o alvo por
// um botão de mentira com as classes certas na mão.
import { TopBar } from "@/components/shell/TopBar";

function classes(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

describe("o hambúrguer do topo em 320px (#5332)", () => {
  it("tem piso de 44px e não encolhe dentro do flex do grupo da esquerda", () => {
    render(<TopBar />);
    const menu = screen.getByRole("button", { name: "Abrir navegação" });
    const c = classes(menu);

    // `shrink-0` é o conserto da causa: o item deixa de aceitar a sobra
    // negativa do cabeçalho. `min-w-11` (= 2.75rem = 44px) é o piso escrito na
    // classe, que sobrevive a qualquer vizinho novo.
    expect(c).toContain("shrink-0");
    expect(c).toContain("min-w-11");
    // Sem `w-11` o botão não teria os 44px de desenho; com `shrink` explícito
    // (o default do flex) o piso voltaria a ser ignorado.
    expect(c).toContain("w-11");
    expect(c).not.toContain("shrink");
  });

  it("mantém 44px de ALTURA e só some acima de `md` — a altura não foi o conserto", () => {
    render(<TopBar />);
    const c = classes(screen.getByRole("button", { name: "Abrir navegação" }));

    expect(c).toContain("h-11");
    expect(c).toContain("md:hidden");
    // Nada de `min-h-*`/`h-*` novo: o defeito era a largura, e a altura já
    // cumpria os 44px.
    expect(c.filter((k) => k.startsWith("min-h-"))).toEqual([]);
    expect(c.filter((k) => /^h-/.test(k))).toEqual(["h-11"]);
  });

  it("o grupo da esquerda continua podendo encolher — a correção é no botão, não no grupo", () => {
    render(<TopBar />);
    const menu = screen.getByRole("button", { name: "Abrir navegação" });
    const grupo = menu.parentElement as HTMLElement;
    const c = classes(grupo);

    // `min-w-0` no grupo é o que permite o seletor de organização ceder 4px
    // quando preciso; tirá-lo jogaria o estouro para o cabeçalho inteiro.
    expect(c).toContain("flex");
    expect(c).toContain("min-w-0");
    expect(c).toContain("gap-2");
  });

  it("o piso de 44px da coluna da busca (#5096) continua de pé", () => {
    render(<TopBar />);
    const busca = screen.getByTestId("topo-busca");
    const c = classes(busca);

    expect(c).toContain("max-[359px]:min-w-11");
    expect(c).not.toContain("min-w-11");
  });
});
