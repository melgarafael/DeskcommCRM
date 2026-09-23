/** Destinos diários visíveis; catálogo completo buscável com o mesmo RBAC. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

import { Sidebar } from "@/components/shell/Sidebar";
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
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/components/connections/ConnectionHealthDot", () => ({
  ConnectionHealthDot: () => null,
}));
vi.mock("@/app/actions/shell/toggleSidebar", () => ({
  toggleSidebar: vi.fn(),
}));
// Busca a versão via react-query; sem QueryClientProvider ele lança, e o
// rodapé de versão não é o que estes testes examinam.
vi.mock("@/components/shell/VersionFooter", () => ({
  VersionFooter: () => null,
}));

function comoPapel(role: ActiveOrg["role"]) {
  authRef.user = { is_platform_admin: false };
  authRef.activeOrg = { orgId: "org-1", name: "Org", role };
}

afterEach(cleanup);

describe("Navegação leve do escreve.ai", () => {
  it("mantém os destinos diários visíveis e os demais descobríveis", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    expect(screen.getByRole("link", { name: "Funis" })).toHaveAttribute("href", "/app/kanban");
    expect(screen.getByRole("link", { name: "Funcionários" })).toHaveAttribute(
      "href",
      "/app/ai/agents",
    );
    expect(screen.getByRole("link", { name: "Escreve aí" })).toHaveAttribute("href", "/app");
    expect(screen.queryByRole("heading")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Todas as ferramentas" }));
    expect(screen.getByRole("option", { name: /Etapas do funil/ })).toBeVisible();
    expect(screen.getByRole("option", { name: /Audit Log/ })).toBeVisible();
  });
  it("não oferece áreas administrativas ao atendente", () => {
    comoPapel("agent");
    render(<Sidebar collapsed={false} />);
    expect(screen.queryByRole("link", { name: "Funcionários" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Todas as ferramentas" }));
    expect(screen.queryByRole("option", { name: /Credenciais|Audit Log/ })).toBeNull();
  });
  it("a barra recolhida mantém nomes acessíveis e destino ativo", () => {
    comoPapel("admin");
    render(<Sidebar collapsed />);
    expect(screen.getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Todas as ferramentas" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Expandir sidebar" })).toBeVisible();
  });
});
