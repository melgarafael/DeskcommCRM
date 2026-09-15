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

vi.mock("@/lib/api/client", () => ({ apiClient: { post, get: vi.fn(), patch: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ usePermission: () => estado.podeMover }));
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

function renderMenu() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <div className="group">
        <KanbanCardActions lead={LEAD} pipelineId="p-1" />
      </div>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  estado.podeMover = true;
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

    await user.click(screen.getByRole("button", { name: "Excluir" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/api/v1/leads/bulk", {
      action: "delete",
      lead_ids: ["l-1"],
      params: {},
    });
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
  });
});
