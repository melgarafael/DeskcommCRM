/**
 * No celular o seletor de organização é só o ícone.
 *
 * Por que isto tem teste: medido numa instalação real em 360px, com o nome
 * escrito o botão ocupava 153px e o cabeçalho tinha 14 sobreposições — a pior de
 * 96px, o nome da organização por baixo do campo de busca. Hambúrguer + nome +
 * busca + sino + avatar não cabem em 360px.
 *
 * jsdom não faz layout, então o teste prova a REGRA (quem carrega a classe que
 * esconde abaixo de `md`) e o que não pode se perder junto: o nome ainda tem que
 * chegar a quem usa leitor de tela. A prova de pixel é a medição por
 * `getBoundingClientRect` registrada no PR.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({
    organizations: [
      { organization_id: "a", organization_name: "Studio Mariana Castro" },
      { organization_id: "b", organization_name: "Outra" },
    ],
    is_platform_admin: false,
    support: null,
  }),
  useActiveOrg: () => ({ orgId: "a", name: "Studio Mariana Castro" }),
}));
vi.mock("./OrganizationTransitionProvider", () => ({
  useOrganizationTransition: () => ({ begin: vi.fn(), cancel: vi.fn() }),
}));
vi.mock("@/app/actions/shell/setActiveOrg", () => ({ setActiveOrg: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { TenantSwitcher } from "./TenantSwitcher";

describe("seletor de organização no celular", () => {
  it("o nome fica escondido abaixo de md, e o ícone continua clicável", () => {
    render(<TenantSwitcher />);
    const botao = screen.getByTestId("tenant-switcher");

    const nome = botao.querySelector("span");
    expect(nome?.textContent).toBe("Studio Mariana Castro");
    expect(nome?.className).toContain("hidden");
    expect(nome?.className).toContain("md:inline");
  });

  it("o nome NÃO se perde para quem usa leitor de tela", () => {
    // Esconder por `hidden` tira do fluxo E da árvore de acessibilidade. Sem o
    // aria-label o botão viraria um ícone mudo — conserto de layout que quebra
    // acessibilidade não é conserto.
    render(<TenantSwitcher />);
    expect(screen.getByTestId("tenant-switcher").getAttribute("aria-label")).toContain(
      "Studio Mariana Castro",
    );
  });

  it("no desktop nada muda: o nome continua escrito", () => {
    render(<TenantSwitcher />);
    const nome = screen.getByTestId("tenant-switcher").querySelector("span");
    // `md:inline` é o que devolve o nome acima de 768px — se sumir, o desktop
    // regrediu junto com o conserto do celular.
    expect(nome?.className).toMatch(/md:inline/);
    expect(nome?.className).toContain("truncate");
  });
});
