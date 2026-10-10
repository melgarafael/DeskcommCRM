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
