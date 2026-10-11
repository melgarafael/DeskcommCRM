import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KanbanCardActions } from "@/components/kanban/KanbanCardActions";
import type { AssignableMember } from "@/hooks/inbox/useAssignableMembers";
import type { AssignableAgent } from "@/hooks/kanban/useAssignableAgents";
import type { Lead } from "@/lib/types/leads";

/**
 * Submenu "Responsável" do card do funil (issue #2702): o `DropdownMenuSubContent`
 * era renderizado DENTRO do `DropdownMenuContent`, que tem `overflow-x-hidden`
 * e a animação `ds-painel` (`app/globals.css`) — o `translate: 0 0` que sobra
 * depois de abrir (fill-mode `both`) faz do menu pai o containing block dos
 * elementos `position: fixed`, que é como o Popper do Radix posiciona o
 * submenu. Resultado: o submenu abria cortado/atrás do menu, invisível.
 *
 * jsdom não calcula layout, então o que este teste vigia é a INVARIANTE que
 * decide o corte no navegador: o submenu precisa nascer FORA da caixa do menu
 * pai (portal, como o próprio `DropdownMenuContent` já faz) e numa camada de
 * z-index acima dele. Sem portal, o mesmo `overflow-hidden` que esconde o
 * submenu no navegador é exatamente o que `parentMenu.contains(subMenu)`
 * mede aqui.
 */

const membros = vi.hoisted(() => ({
  lista: [] as AssignableMember[],
}));
const agentes = vi.hoisted(() => ({
  lista: [] as AssignableAgent[],
}));
const post = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/client", () => ({ apiClient: { post, get, patch: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: (chave: string) => chave === "pipeline.move_card",
}));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useWinLead: () => ({ mutate: vi.fn(), isPending: false }),
  useEditLead: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/kanban/usePropostaEnviadaDoLead", () => ({
  usePropostaEnviadaDoLead: () => ({ data: undefined }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: membros.lista }),
}));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({
  useAssignableAgents: () => ({ data: agentes.lista }),
}));
vi.mock("@/components/kanban/LoseLeadDialog", () => ({ LoseLeadDialog: () => null }));
vi.mock("@/components/kanban/MoveToOtherPipelineDialog", () => ({
  MoveToOtherPipelineDialog: () => null,
}));
vi.mock("@/components/kanban/EditLeadDialog", () => ({ EditLeadDialog: () => null }));

const LEAD = {
  id: "l-1",
  title: "Proposta da ACME",
  owner_user_id: null,
  owner_agent_id: null,
} as unknown as Lead;

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <div className="group">
        <KanbanCardActions lead={LEAD} pipelineId="p-1" />
      </div>
    </QueryClientProvider>,
  );
}

/** Abre o menu "⋯" e o submenu "Responsável" (hover, o gesto do desktop). */
async function abrirSubmenuResponsavel(user: ReturnType<typeof userEvent.setup>) {
  renderCard();
  await user.click(screen.getByRole("button", { name: "Ações do lead" }));
  await screen.findByRole("menuitem", { name: "Editar" });
  await user.hover(screen.getByRole("menuitem", { name: "Responsável" }));
  return await screen.findByRole("menu", { name: "Responsável" });
}

/** O z-index efetivo declarado na classe do wrapper (jsdom não aplica CSS). */
function zIndexDe(el: HTMLElement): number {
  const casa = el.className.match(/(?:^|\s)z-\[?(\d+)\]?/);
  return casa ? Number(casa[1]) : 0;
}

beforeEach(() => {
  membros.lista = [];
  agentes.lista = [];
  post.mockReset();
  post.mockResolvedValue({ data: { updated_count: 1 } });
  get.mockReset();
  get.mockResolvedValue({ data: [] });
});

describe("menu do card — submenu Responsável (#2702)", () => {
  it("com muitos membros, o SubContent abre FORA do menu pai e uma camada de z-index acima", async () => {
    membros.lista = Array.from({ length: 12 }, (_, i) => ({
      user_id: `u-${i + 1}`,
      role: "agent",
      full_name: `Membro ${String(i + 1).padStart(2, "0")}`,
    }));
    agentes.lista = [
      { agent_id: "a-1", name: "Comercial", version_number: 3, is_archived: false },
      { agent_id: "a-2", name: "Suporte", version_number: null, is_archived: false },
    ] as unknown as AssignableAgent[];

    const user = userEvent.setup();
    const subMenu = await abrirSubmenuResponsavel(user);

    // O número de membros é o bug: é a lista longa que estoura a caixa.
    for (const m of membros.lista) {
      expect(await screen.findByRole("menuitem", { name: m.full_name! })).toBeTruthy();
    }
    // O item do agente carrega a versão ao lado do nome (v3) — o nome
    // acessível é "Comercial v3".
    expect(screen.getByRole("menuitem", { name: /Comercial/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Suporte/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Sem responsável" })).toBeTruthy();

    // Invariante do fix: o submenu NÃO vive dentro do menu pai. Portado para o
    // body, ele deixa de ser cortado pelo `overflow-hidden`/`translate` do pai.
    // O pai é o menu que guarda as ações do card — identificado pelo conteúdo,
    // não pelo nome acessível (que depende do accname do browser).
    const menuPai = screen.getByRole("menuitem", { name: "Editar" }).closest<HTMLElement>('[role="menu"]')!;
    expect(subMenu).not.toBe(menuPai);
    expect(menuPai.contains(subMenu)).toBe(false);
    expect(document.body.contains(subMenu)).toBe(true);

    // Camada acima do pai: empate de z-index é empate de sorte na ordem do DOM.
    expect(zIndexDe(subMenu)).toBeGreaterThan(zIndexDe(menuPai));
    // Lista longa rola DENTRO da altura disponível em vez de sair da tela.
    expect(subMenu.className).toContain(
      "max-h-[var(--radix-dropdown-menu-content-available-height)]",
    );
  });

  it("sem membros e sem agentes, o submenu ainda abre com 'Sem responsável' — e igualmente fora do menu pai", async () => {
    const user = userEvent.setup();
    const subMenu = await abrirSubmenuResponsavel(user);

    expect(await screen.findByRole("menuitem", { name: "Sem responsável" })).toBeTruthy();
    // Sem membros não há separador sobrando (o do componente some com a lista).
    expect(subMenu.querySelectorAll('[role="menuitem"]')).toHaveLength(1);

    // O pai é o menu que guarda as ações do card — identificado pelo conteúdo,
    // não pelo nome acessível (que depende do accname do browser).
    const menuPai = screen.getByRole("menuitem", { name: "Editar" }).closest<HTMLElement>('[role="menu"]')!;
    expect(menuPai.contains(subMenu)).toBe(false);
    expect(document.body.contains(subMenu)).toBe(true);
    expect(zIndexDe(subMenu)).toBeGreaterThan(zIndexDe(menuPai));
  });
});
