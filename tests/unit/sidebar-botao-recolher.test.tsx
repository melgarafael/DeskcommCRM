/**
 * Issue #2722 — o controle de recolher mora no ALTO, não no rodapé.
 *
 * O que estes testes protegem:
 *
 *  - aberta, o botão está DENTRO da linha da logo (`.h-14`) e o rodapé
 *    (`border-t`) não o contém mais — é o regressor que impede o controle
 *    de voltar para baixo por um refactor;
 *  - recolhida, ele existe como faixa sob a marca, fora da linha `.h-14`
 *    (os 64px do trilho não comportam botão ao lado do símbolo);
 *  - clicar continua gravando a preferência (`toggleSidebar` com o estado
 *    ATUAL, a mesma semântica do botão antigo).
 *
 * A lógica de persistência é do server action e mora em outro teste; aqui é
 * a SUPERFÍCIE — onde o botão vive.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Sidebar } from "@/components/shell/Sidebar";
import { MarcaDaInstalacaoProvider } from "@/lib/branding/contexto";
import { toggleSidebar } from "@/app/actions/shell/toggleSidebar";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

const authRef: { user: Pick<AuthUser, "is_platform_admin">; activeOrg: ActiveOrg | null } = {
  user: { is_platform_admin: false },
  activeOrg: null,
};

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => authRef,
  usePermission: () => false,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inbox",
}));
vi.mock("@/components/connections/ConnectionHealthDot", () => ({
  ConnectionHealthDot: () => null,
}));
vi.mock("@/components/shell/ContadorDeCasos", () => ({
  ContadorDeCasos: () => null,
}));
vi.mock("@/components/shell/ContadorDaFila", () => ({
  ContadorDaFila: () => null,
}));
vi.mock("@/app/actions/shell/toggleSidebar", () => ({
  toggleSidebar: vi.fn(),
}));
vi.mock("@/components/shell/VersionFooter", () => ({
  VersionFooter: () => null,
}));

function comoPapel(role: ActiveOrg["role"]) {
  authRef.user = { is_platform_admin: false };
  authRef.activeOrg = { orgId: "org-1", name: "Org", role };
}

function linhaDaLogo(): Element | null {
  return document.querySelector(".h-14");
}

function rodape(): Element | null {
  return document.querySelector(".border-t");
}

afterEach(cleanup);

describe("Sidebar — controle de recolher no alto (#2722)", () => {
  it("aberta: o botão vive na linha da logo, e o rodapé não o contém", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    const botao = screen.getByRole("button", { name: "Recolher sidebar" });
    expect(linhaDaLogo()?.contains(botao)).toBe(true);
    expect(rodape()?.contains(botao)).toBe(false);
  });

  it("aberta: clicar grava a preferência com o estado atual (false)", async () => {
    comoPapel("admin");
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} />);
    await user.click(screen.getByRole("button", { name: "Recolher sidebar" }));
    expect(vi.mocked(toggleSidebar)).toHaveBeenCalledWith(false);
  });

  it("recolhida: o «» existe fora da linha da logo, antes do menu", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={true} />);
    const botao = screen.getByRole("button", { name: "Expandir sidebar" });
    expect(linhaDaLogo()?.contains(botao)).toBe(false);
    expect(rodape()?.contains(botao)).toBe(false);
    // Antes do menu, não depois: o controle é o primeiro thing do alto.
    const menu = document.querySelector("nav")!;
    expect(
      menu.compareDocumentPosition(botao) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
  });
});

/**
 * O que o review do PR #2723 mediu com `getBoundingClientRect` numa réplica
 * da linha da logo (issue #2722): com marca própria, a linha ESTOURAVA a
 * barra de 240px — e não só no caso extremo.
 *
 * O jsdom não mede layout, então estes casos conferem a CLASSE que produz o
 * comportamento medido. Se alguém tirar uma delas num refactor, o teste cai
 * mesmo sem ninguém ter aberto a tela.
 */
describe("Sidebar — a marca não disputa a barra com o botão (#2722 / review #2723)", () => {
  it("aberta: o botão é só o ícone, mas mantém aria-label e ganha title", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    const botao = screen.getByRole("button", { name: "Recolher sidebar" });
    // O rótulo deixa de ser texto visível: no review ele custava ~54px de uma
    // linha com ~207px úteis, e uma logo-palavra 5:1 (140px) já estourava.
    expect(screen.queryByText("Recolher")).toBeNull();
    // Acessibilidade intacta: mesmo nome para leitor de tela, tooltip no hover.
    expect(botao.getAttribute("aria-label")).toBe("Recolher sidebar");
    expect(botao).toHaveAttribute("title", "Recolher sidebar");
  });

  it("aberta: o wrapper do botão é shrink-0, para não ser o primeiro espremido", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    const botao = screen.getByRole("button", { name: "Recolher sidebar" });
    // O botão é o CONTROLE — se ele encolher, some o que o usuário clica.
    expect(botao.parentElement?.className).toContain("shrink-0");
  });

  it("com marca própria: a imagem tem teto que encolhe, e o wrapper é min-w-0", () => {
    authRef.user = { is_platform_admin: false };
    authRef.activeOrg = {
      orgId: "org-1",
      name: "Org",
      role: "admin",
      marca: { nome: "Clínica Sorriso Feliz", logoUrl: "https://marca/logo.png" },
    };
    render(<Sidebar collapsed={false} />);
    const img = document.querySelector("img")!;
    // O review provou a pegadinha: `max-w-full` + `max-w-[10rem]` disputam a
    // MESMA propriedade e só um vale. O teto tem de ser um único `min()`.
    expect(img.className).toContain("max-w-[min(10rem,100%)]");
    expect(img.className).not.toContain("max-w-[10rem]");
    // `min-w-0` porque item de flex não encolhe abaixo do `min-width: auto`.
    expect(img.parentElement?.className).toContain("min-w-0");
  });

  it("sem logo: o nome longo trunca, com o nome completo no title", () => {
    // O nome da barra vem de `marca.nome ?? brand.name`, NUNCA de
    // `activeOrg.name` — e `logo` é `marca.logoUrl || brand.logoUrl`. Sem o
    // provider, o contexto default devolve a marca do PRODUTO e a barra
    // desenha o símbolo no lugar do texto (foi o que este teste pegou na
    // primeira rodada). `logoUrl: null` nos dois lados é o que dá a tela sem
    // arte, que é o caso medido no review.
    authRef.user = { is_platform_admin: false };
    authRef.activeOrg = {
      orgId: "org-1",
      name: "Org",
      role: "admin",
      marca: { nome: "Clínica Odontológica Sorriso Feliz", logoUrl: null },
    };
    render(
      <MarcaDaInstalacaoProvider
        marca={{ name: "Sistema do Revendedor", logoUrl: null, initial: "S" }}
      >
        <Sidebar collapsed={false} />
      </MarcaDaInstalacaoProvider>,
    );
    // Medido no review: 3 linhas (72px) dentro de uma linha de 56px.
    const nome = screen.getByText("Clínica Odontológica Sorriso Feliz");
    expect(nome.className).toContain("truncate");
    expect(nome).toHaveAttribute("title", "Clínica Odontológica Sorriso Feliz");
  });
});
