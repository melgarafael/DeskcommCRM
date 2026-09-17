import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KanbanCardActions } from "@/components/kanban/KanbanCardActions";
import type { Lead } from "@/lib/types/leads";

/**
 * Card do funil sem "Excluir" (issue #910): excluir só existia na barra de
 * seleção em lote, e no toque nem o menu do card nem a caixa de seleção
 * apareciam (os dois só ficavam visíveis no hover).
 */

const estado = vi.hoisted(() => ({ podeMover: true }));
const post = vi.hoisted(() => vi.fn());
/**
 * O dublê RECEBE a chave. Um `usePermission: () => estado.podeMover` sem
 * parâmetro prova que EXISTE um gate, não que o gate é `pipeline.move_card`:
 * trocar a chave por outra — inclusive uma de piso mais alto, que esconderia o
 * item de todo `agent` — deixaria a suíte verde, e o `ACTION_MIN_ROLE` é
 * `Record<string, Role>`, então nem o typecheck acusaria.
 */
const permissao = vi.hoisted(() => vi.fn((_chave: string) => true));

vi.mock("@/lib/api/client", () => ({ apiClient: { post, get: vi.fn(), patch: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: (chave: string) => permissao(chave),
}));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useWinLead: () => ({ mutate: vi.fn(), isPending: false }),
  useEditLead: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({ useAssignableAgents: () => ({ data: [] }) }));
vi.mock("@/components/kanban/LoseLeadDialog", () => ({ LoseLeadDialog: () => null }));
vi.mock("@/components/kanban/EditLeadDialog", () => ({ EditLeadDialog: () => null }));

const LEAD = {
  id: "l-1",
  title: "Proposta da ACME",
  owner_user_id: null,
  owner_agent_id: null,
} as unknown as Lead;

/**
 * O `onClick` que o CARD tem. `components/kanban/KanbanCard.tsx` põe
 * `onClick={handleClick}` na `<div>` que envolve as ações, e `decidirClique` não
 * inspeciona o alvo: qualquer clique que suba até ali abre o dossiê do lead.
 * O dublê reproduz exatamente essa relação — ancestral com `onClick`, ações
 * dentro —, que é o que decide se um clique no overlay portado vira dossiê.
 */
const abrirDossie = vi.hoisted(() => vi.fn());

function renderMenu() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <div className="group" onClick={() => abrirDossie()}>
        <KanbanCardActions lead={LEAD} pipelineId="p-1" />
      </div>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  estado.podeMover = true;
  permissao.mockReset();
  // A chave ENTRA na conta do dublê, e não só numa asserção. Medido na triagem:
  // com `mockImplementation(() => estado.podeMover)` — que ignora o argumento —
  // trocar a chave do componente por uma inexistente deixava 6 dos 7 casos
  // VERDES; o único vermelho era o `toHaveBeenCalledWith` abaixo. Uma asserção
  // só, num caso só, é catraca estreita para um gate que decide se uma ação
  // DESTRUTIVA aparece. Assim, a chave errada apaga o item e todo caso que
  // depende dele vermelha.
  permissao.mockImplementation((chave) => chave === "pipeline.move_card" && estado.podeMover);
  abrirDossie.mockReset();
  post.mockReset();
  post.mockResolvedValue({ data: { updated_count: 1 } });
});

describe("menu do card — Excluir", () => {
  it("excluir pede confirmação nomeando o card e só então apaga pela rota em lote", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole("button", { name: "Ações do lead" }));
    await user.click(await screen.findByRole("menuitem", { name: "Excluir" }));

    expect(await screen.findByText('Excluir "Proposta da ACME"?')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    // Qual gate, e não só "algum gate": é `pipeline.move_card` que decide se
    // Excluir aparece, a mesma chave que a rota em lote cobra.
    expect(permissao).toHaveBeenCalledWith("pipeline.move_card");

    await user.click(screen.getByRole("button", { name: "Excluir" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/api/v1/leads/bulk", {
      action: "delete",
      lead_ids: ["l-1"],
      params: {},
    });
  });

  it("cancelar fecha a confirmação e segue sem excluir", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole("button", { name: "Ações do lead" }));
    await user.click(await screen.findByRole("menuitem", { name: "Excluir" }));
    await screen.findByText('Excluir "Proposta da ACME"?');

    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    await waitFor(() => expect(screen.queryByText('Excluir "Proposta da ACME"?')).toBeNull());
    expect(post).not.toHaveBeenCalled();
  });

  it("confirmar é o que exclui — e uma vez só, mesmo com dois cliques", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole("button", { name: "Ações do lead" }));
    await user.click(await screen.findByRole("menuitem", { name: "Excluir" }));
    await screen.findByText('Excluir "Proposta da ACME"?');

    const confirmar = screen.getByRole("button", { name: "Excluir" });
    await user.click(confirmar);
    // Segundo clique no MESMO botão: enquanto a rota não responde ele está
    // `disabled`, e excluir em dobro é o erro que não tem desfazer.
    await user.click(confirmar);

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("⭐ clicar FORA da confirmação não abre o dossiê do lead por trás dela", async () => {
    // O gesto padrão de desistir é clicar fora. O overlay do Radix é renderizado
    // DENTRO do portal deste componente, e portal do React propaga evento pela
    // ÁRVORE REACT — ou seja, pelo card, cujo `onClick` não inspeciona o alvo
    // (`components/kanban/KanbanCard.tsx`, `decidirClique`). Sem a barreira, o
    // clique de cancelar abria o dossiê atrás de uma janela que nem fecha (o
    // `AlertDialog` não fecha por clique fora, de propósito).
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole("button", { name: "Ações do lead" }));
    await user.click(await screen.findByRole("menuitem", { name: "Excluir" }));
    await screen.findByText('Excluir "Proposta da ACME"?');
    abrirDossie.mockReset();

    // O overlay: o irmão do conteúdo dentro do portal, o que cobre a tela.
    const overlay = document.querySelector("[data-slot=alert-dialog-overlay], [role=alertdialog]")!
      .parentElement!.querySelector("div.fixed.inset-0")!;
    await user.click(overlay as HTMLElement);

    expect(abrirDossie).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("CONTROLE: clicar no CARD, fora de qualquer janela, ABRE o dossiê", async () => {
    // Sem este controle, "não abriu o dossiê" passaria também com um card que
    // não abre dossiê nenhum — e a barreira acima estaria medindo o nada.
    const user = userEvent.setup();
    const { container } = renderMenu();
    await user.click(container.querySelector("div.group")!);
    expect(abrirDossie).toHaveBeenCalledTimes(1);
  });

  it("sem permissão de mexer no funil, Excluir não é oferecido", async () => {
    estado.podeMover = false;
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole("button", { name: "Ações do lead" }));
    await screen.findByRole("menuitem", { name: "Editar" });
    expect(screen.queryByRole("menuitem", { name: "Excluir" })).toBeNull();
  });

  it("o botão do menu não depende de hover: no toque ele fica visível", () => {
    renderMenu();
    const botao = screen.getByRole("button", { name: "Ações do lead" });
    // Mesmo padrão de `components/inbox/MessageBubble.tsx`: visível por padrão,
    // escondido até o hover só onde existe hover.
    expect(botao.className).toContain("[@media(hover:hover)]:opacity-0");
    expect(botao.className).toContain("[@media(hover:hover)]:group-hover:opacity-100");
    expect(botao.className.split(/\s+/)).not.toContain("opacity-0");
    // No desktop quem navega por teclado tabula até aqui: sem isto o foco
    // pousa num botão invisível, que só aparece depois que o menu abre.
    expect(botao.className).toContain("focus-visible:opacity-100");
  });
});
