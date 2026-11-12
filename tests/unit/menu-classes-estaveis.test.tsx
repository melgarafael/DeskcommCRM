/**
 * O CONTRATO DE CLASSES ESTÁVEIS DO MENU LATERAL (#4463, item 2).
 *
 * O defeito medido: o grupo do menu é `<div className="space-y-1">` e o item é um
 * `<Link>` sem classe de identidade — quem personaliza por CSS não tem o que
 * mirar, e o único gancho existente (`id="nav-grupo-…"`) é recusado pelo
 * validador de `/admin/marca`, que só aceita seletor de classe.
 *
 * O conserto NÃO é renomear tudo: é declarar um contrato fechado (uma classe por
 * grupo, uma por destino, derivadas de `group.id`/`href`) e prendê-lo aqui. Este
 * arquivo é a régua: acrescentar grupo ou destino sem classe, ou mudar o nome de
 * uma classe existente, reprova.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sidebar } from "@/components/shell/Sidebar";
import { validarCssPersonalizado } from "@/lib/branding/css-personalizado";
import { GRUPO_NO_RODAPE, NAV_GROUPS, NAV_CATALOG } from "@/lib/navigation/catalogo";
import {
  CLASSES_DE_GRUPO,
  CLASSES_DE_ITEM,
  classeDoGrupo,
  classeDoItem,
} from "@/lib/navigation/classes-estaveis";
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
  useRouter: () => ({ prefetch: vi.fn() }),
  usePathname: () => "/app/inbox",
}));
vi.mock("@/components/connections/ConnectionHealthDot", () => ({
  ConnectionHealthDot: () => null,
}));
vi.mock("@/components/shell/ContadorDeCasos", () => ({ ContadorDeCasos: () => null }));
vi.mock("@/components/shell/ContadorDaFila", () => ({ ContadorDaFila: () => null }));
vi.mock("@/components/shell/ContadorDeTarefas", () => ({ ContadorDeTarefas: () => null }));
vi.mock("@/app/actions/shell/toggleSidebar", () => ({ toggleSidebar: vi.fn() }));
vi.mock("@/components/shell/VersionFooter", () => ({ VersionFooter: () => null }));

function comoAdmin() {
  authRef.user = { is_platform_admin: false };
  authRef.activeOrg = { orgId: "org-1", name: "Org", role: "admin" };
}

afterEach(cleanup);

describe("o contrato de classes do menu é fechado e declarado", () => {
  it("todo grupo do catálogo tem UMA classe, kebab-case e sem colisão", () => {
    for (const grupo of NAV_GROUPS) {
      expect(CLASSES_DE_GRUPO[grupo.id], grupo.id).toMatch(/^nav-grupo-[a-z0-9-]+$/);
      expect(classeDoGrupo(grupo.id)).toBe(CLASSES_DE_GRUPO[grupo.id]);
    }
    const classes = Object.values(CLASSES_DE_GRUPO);
    expect(new Set(classes).size).toBe(classes.length);
  });

  it("as classes de grupo têm os nomes que a issue combinou", () => {
    // Lista FECHADA: o nome é contrato público para o CSS do cliente, então
    // mudar qualquer um destes é quebra de compatibilidade, não refatoração.
    expect(CLASSES_DE_GRUPO).toEqual({
      atendimento: "nav-grupo-atendimento",
      crm: "nav-grupo-crm",
      ia: "nav-grupo-ia",
      canais: "nav-grupo-canais",
      analise: "nav-grupo-analise",
      organizacao: "nav-grupo-organizacao",
    });
  });

  it("todo destino tem uma classe de item, única e derivada do href", () => {
    for (const destino of NAV_CATALOG) {
      const classe = CLASSES_DE_ITEM[destino.href];
      expect(classe, destino.href).toMatch(/^nav-item-[a-z0-9-]+$/);
      expect(classe).toBe(classeDoItem(destino.href));
    }
    const classes = Object.values(CLASSES_DE_ITEM);
    expect(new Set(classes).size).toBe(classes.length);
    // Âncoras conhecidas: o CSS de quem já personaliza aponta para estes nomes.
    expect(CLASSES_DE_ITEM["/app/inbox"]).toBe("nav-item-inbox");
    expect(CLASSES_DE_ITEM["/app/kanban"]).toBe("nav-item-kanban");
    expect(CLASSES_DE_ITEM["/app/ai/cases"]).toBe("nav-item-ai-cases");
  });

  it("o validador de /admin/marca aceita a regra que o contrato torna possível", () => {
    const regra = validarCssPersonalizado(".nav-grupo-crm .rounded-md:hover { color: #52645a; }");
    expect(regra.erro).toBeNull();
    expect(regra.css).toContain(":root:root .nav-grupo-crm .rounded-md:hover");
  });
});

describe("o menu desenha as classes do contrato", () => {
  it("cada grupo carrega a sua classe, no contêiner que envolve título e itens", () => {
    comoAdmin();
    render(<Sidebar collapsed={false} />);

    const nav = screen.getByRole("navigation", { name: "Navegação principal" });
    for (const grupo of NAV_GROUPS) {
      if (grupo.id === GRUPO_NO_RODAPE) continue; // conferido no teste do rodapé, abaixo
      expect(nav.querySelector(`.${classeDoGrupo(grupo.id)}`), grupo.id).not.toBeNull();
    }

    const crm = nav.querySelector(".nav-grupo-crm");
    if (!crm) throw new Error("esperava o grupo CRM no menu");
    // O título do grupo está DENTRO do contêiner com a classe: é ele que o CSS
    // do cliente alcança com `.nav-grupo-crm .rounded-md:hover`.
    expect(within(crm as HTMLElement).getByRole("heading", { name: "CRM" })).toBeTruthy();
    expect(within(crm as HTMLElement).getByRole("link", { name: "Funis" })).toBeTruthy();
  });

  it("cada item carrega a classe do seu destino", () => {
    comoAdmin();
    render(<Sidebar collapsed={false} />);

    const inbox = screen.getByRole("link", { name: /Inbox/ });
    expect(inbox.className).toContain("nav-item-inbox");
    // E a classe do item não vaza para o link vizinho de outro grupo.
    const funis = screen.getByRole("link", { name: "Funis" });
    expect(funis.className).toContain("nav-item-kanban");
    expect(funis.className).not.toContain("nav-item-inbox");
  });

  it("o grupo do rodapé fixo também carrega a sua classe, e os links dele a do destino", () => {
    // `organizacao` não é desenhado no loop dos grupos: o Sidebar o tira da
    // lista e o põe no rodapé, FORA da nav principal. A doc promete
    // `nav-grupo-organizacao` nos três idiomas, então o rodapé tem de tê-la.
    comoAdmin();
    const { container } = render(<Sidebar collapsed={false} />);

    const nav = screen.getByRole("navigation", { name: "Navegação principal" });
    const rodape = container.querySelector(`.${classeDoGrupo(GRUPO_NO_RODAPE)}`);
    if (!rodape) throw new Error("esperava a classe do grupo no rodapé fixo");
    expect(nav.contains(rodape), "o rodapé fica fora da nav principal").toBe(false);

    const configuracoes = within(rodape as HTMLElement).getByRole("link", { name: "Configurações" });
    expect(configuracoes.className).toContain("nav-item-settings");
    const ajuda = within(rodape as HTMLElement).getByRole("link", { name: "Ajuda" });
    expect(ajuda.className).toContain("nav-item-ajuda");
  });

  it("a classe do grupo também existe recolhido (o CSS não pode depender do modo)", () => {
    comoAdmin();
    render(<Sidebar collapsed />);
    const nav = screen.getByRole("navigation", { name: "Navegação principal" });
    expect(nav.querySelector(".nav-grupo-atendimento")).not.toBeNull();
  });
});
