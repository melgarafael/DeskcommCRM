/**
 * ⌘K. Até aqui a barra "Buscar…" do topo era um `console.info` com o comentário
 * "UI not yet implemented" — a única saída de emergência para quem não achava
 * uma tela era uma promessa vazia.
 *
 * v1 busca só NAVEGAÇÃO. Contato, conversa e lead são outra fonte de dados e
 * outra feature.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CommandPalette } from "@/components/shell/CommandPalette";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

const push = vi.fn();
const authRef: { user: Pick<AuthUser, "is_platform_admin">; activeOrg: ActiveOrg | null } = {
  user: { is_platform_admin: false },
  activeOrg: { orgId: "org-1", name: "Org", role: "admin" },
};

vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => authRef }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

function comoPapel(role: ActiveOrg["role"]) {
  authRef.activeOrg = { orgId: "org-1", name: "Org", role };
}

afterEach(() => {
  cleanup();
  push.mockClear();
  comoPapel("admin");
});

function abrir() {
  return render(<CommandPalette open onOpenChange={() => {}} />);
}

describe("CommandPalette", () => {
  it("acha uma tela que o sidebar não mostra", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "conhec");
    expect(screen.getByRole("option", { name: /Conhecimento/ })).toBeTruthy();
  });

  it("ignora acento, porque ninguém digita acento com pressa", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "orcamento");
    expect(screen.getByRole("option", { name: /Uso e orçamento/ })).toBeTruthy();
  });

  it("busca também na descrição, não só no rótulo", async () => {
    const user = userEvent.setup();
    abrir();
    // Ninguém procura "Radar" por esse nome; procura pelo problema que resolve.
    await user.type(screen.getByRole("combobox"), "esfriou");
    expect(screen.getByRole("option", { name: /Radar/ })).toBeTruthy();
  });

  it("acha o Jev pelo nome, embora ele não tenha tela própria", async () => {
    const user = userEvent.setup();
    abrir();
    // O cartão dele mora em Provedores; sem o nome na descrição, quem ouviu
    // falar do Jev digitava "jev" e não achava nada.
    await user.type(screen.getByRole("combobox"), "jev");
    const opcao = screen.getByRole("option", { name: /Provedores/ });
    // E VÊ o nome: a descrição longa cortava antes do "Jev" (medido em campo).
    const descricao = opcao.querySelector("p")!.textContent!;
    expect(descricao.indexOf("Jev"), descricao).toBeGreaterThanOrEqual(0);
    expect(descricao.indexOf("Jev"), "o Jev tem de vir no começo").toBeLessThan(20);
  });

  it("o texto de apoio do item destacado usa a cor de frente do destaque, não o cinza", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "jev");
    const destacada = screen.getByRole("option", { selected: true });
    // Cinza sobre o verde do destaque dava 1,2:1. Sem opacidade: o piso de
    // 4,5:1 de lib/branding/contraste.ts só vale para a cor de frente INTEIRA.
    for (const apoio of [destacada.querySelector("p")!, destacada.querySelector("span.uppercase")!]) {
      expect(apoio.classList).toContain("text-accent-foreground");
      expect(apoio.className).not.toMatch(/text-accent-foreground\//);
      expect(apoio.className).not.toContain("text-muted-foreground");
    }
  });

  it("respeita o papel", async () => {
    comoPapel("agent");
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "audit");
    expect(screen.queryByRole("option", { name: /Audit Log/ })).toBeNull();
  });

  it("Enter navega para o item destacado", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "conhec");
    await user.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith("/app/ai/knowledge/sources");
  });

  it("seta para baixo move o destaque antes do Enter", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "a");
    await user.keyboard("{ArrowDown}{Enter}");
    const segundo = screen.getAllByRole("option")[1];
    expect(segundo).toBeDefined();
    expect(push).toHaveBeenCalledWith(segundo?.getAttribute("data-href"));
  });

  it("sem texto, oferece o trabalho do dia em vez de tela vazia", () => {
    abrir();
    expect(screen.getByRole("option", { name: /Inbox/ })).toBeTruthy();
  });

  it("diz quando não achou, em vez de sumir sem explicação", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "zzzzzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/Nada encontrado/i)).toBeTruthy();
  });

  it("permite filtrar por categorias através dos botões", async () => {
    const user = userEvent.setup();
    abrir();
    const btnAtendimento = screen.getByRole("button", { name: /Atendimento/i });
    expect(btnAtendimento).toBeTruthy();
    await user.click(btnAtendimento);
    // Ao filtrar por Atendimento, itens de CRM ou Funcionários não devem aparecer
    expect(screen.getByRole("option", { name: /Inbox/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Contatos/ })).toBeNull();
  });

  it("no catálogo, abre em Atendimento e a seta segue a ordem da tela", async () => {
    const user = userEvent.setup();
    abrir();
    // O catálogo começa por Prospecção (CRM): agrupar pela 1ª aparição punha
    // CRM no topo, e a seta andava pela lista plana, pulando de seção.
    const opcoes = screen.getAllByRole("option");
    expect(opcoes[0]?.getAttribute("data-href")).toBe("/app/inbox");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(push).toHaveBeenCalledWith(opcoes[1]?.getAttribute("data-href"));
  });
});
