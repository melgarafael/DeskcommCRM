/**
 * Sidebar agrupado por objetivo. O que estes testes protegem:
 *
 *  - a hierarquia existe (o usuário reclamou de 17 itens no mesmo peso visual);
 *  - Funis é alcançável sem passar por Configurações — o achado que originou tudo;
 *  - agrupar não criou cabeçalho órfão (grupo cujos filhos a permissão filtrou);
 *  - colapsado não renderiza título nenhum: 6 rótulos em 64px seria ilegível.
 *
 * A regra de quem-vê-o-quê é do registro e está coberta em
 * `navegacao-registry.test.ts`; aqui é a superfície.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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

describe("Sidebar agrupado", () => {
  it("renderiza os títulos de grupo na ordem de uso", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    const titulos = screen
      .getAllByRole("heading")
      .map((el) => el.textContent?.trim())
      .filter(Boolean);
    // Organização não tem título aqui: seu hub (Configurações) vive no rodapé
    // fixo, fora da área que rola — medido, ele caía fora da dobra até em 1080px.
    expect(titulos).toEqual(["Atendimento", "CRM", "Agente de IA", "Canais", "Análise"]);
  });

  it("leva às Etapas do funil sem passar por Configurações", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    // O rótulo mudou: "Funis" passou a ser a LISTA (/app/kanban) e esta tela,
    // que configura as colunas, virou "Etapas do funil". Antes as duas
    // disputavam o mesmo nome no mesmo grupo do menu.
    const etapas = screen.getByRole("link", { name: "Etapas do funil" });
    expect(etapas).toHaveAttribute("href", "/app/settings/tenant/pipelines");
  });

  it("e os dois itens de funil não disputam o mesmo nome", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    expect(screen.getByRole("link", { name: "Funis" })).toHaveAttribute("href", "/app/kanban");
  });

  it("desenterra Audit Log — e Nuvemshop ficou de fora, por escolha", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    // Audit Log só existia via card em Configurações. Canal oficial não está
    // aqui de propósito: virou aba de Conexões no PR #105, e Conexões é a porta.
    expect(screen.getByRole("link", { name: /Audit Log/ })).toBeTruthy();

    // NUVEMSHOP SAIU, e esta linha é a reversão explícita de uma decisão que
    // este mesmo teste travava: a integração tinha sido "desenterrada" para o
    // menu justamente por não ter link nenhum. O dono do produto pediu para
    // ocultá-la — não usa a integração —, então o que era garantia virou o
    // contrário, e fica dito aqui para ninguém "consertar" de volta sem saber.
    //
    // Some do MENU, não do produto: a rota e a página seguem de pé e o ⌘K
    // continua achando (`searchable()` filtra por papel, nunca por `sidebar`).
    expect(screen.queryByRole("link", { name: /Nuvemshop/ })).toBeNull();
  });

  it("Configurações fica no rodapé, nunca dependendo de scroll", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    const config = screen.getByRole("link", { name: /Configurações/ });
    expect(config).toHaveAttribute("href", "/app/settings");
    // Fora da <nav> que rola.
    const nav = screen.getByRole("navigation", { name: "Navegação principal" });
    expect(nav.contains(config)).toBe(false);
  });

  it("não deixa cabeçalho órfão quando a permissão esvazia o grupo", () => {
    // CANAIS é todo manager+/admin. Um agent não pode ver o título sozinho.
    comoPapel("agent");
    render(<Sidebar collapsed={false} />);
    const titulos = screen.getAllByRole("heading").map((el) => el.textContent?.trim());
    expect(titulos).not.toContain("Canais");
    expect(titulos).toContain("Atendimento");
  });

  it("oferece o hub dos grupos que têm um", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    expect(screen.getByRole("link", { name: /Ver tudo em IA/ })).toHaveAttribute("href", "/app/ai");
  });

  it("colapsado esconde os títulos mas mantém os links", () => {
    comoPapel("admin");
    render(<Sidebar collapsed />);
    expect(screen.queryAllByRole("heading")).toHaveLength(0);
    expect(screen.getByRole("link", { name: /Inbox/ })).toBeTruthy();
  });

  it("marca a rota atual com aria-current", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    expect(screen.getByRole("link", { name: /Inbox/ })).toHaveAttribute("aria-current", "page");
    // "Kanban" saiu da interface; o item da mesma URL agora se chama "Funis".
    expect(screen.getByRole("link", { name: "Funis" })).not.toHaveAttribute("aria-current");
  });
});
