/**
 * O "+" DE REGISTRAR VENDA NO CARD DO FUNIL SEGUE O PISO DA ROTA.
 *
 * `POST /api/v1/vendas` cobra `requireRole("agent")`. Abaixo disso o "+" abria
 * o diálogo e o envio terminava em 403 — a prova pela tela do #5087 mediu isso
 * com um `viewer`. O card só oferece o que a rota aceita.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KanbanCardActions } from "@/components/kanban/KanbanCardActions";
import type { Lead } from "@/lib/types/leads";

const estado = vi.hoisted(() => ({ permissoes: new Set<string>() }));

vi.mock("@/lib/api/client", () => ({ apiClient: { post: vi.fn(), get: vi.fn(), patch: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: (chave: string) => estado.permissoes.has(chave),
}));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useWinLead: () => ({ mutate: vi.fn(), isPending: false }),
  useEditLead: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/kanban/usePropostaEnviadaDoLead", () => ({
  usePropostaEnviadaDoLead: () => ({ data: undefined }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({ useAssignableAgents: () => ({ data: [] }) }));
vi.mock("@/components/kanban/LoseLeadDialog", () => ({ LoseLeadDialog: () => null }));
vi.mock("@/components/kanban/MoveToOtherPipelineDialog", () => ({ MoveToOtherPipelineDialog: () => null }));
vi.mock("@/components/kanban/EditLeadDialog", () => ({ EditLeadDialog: () => null }));

const LEAD = { id: "l-1", title: "Proposta da ACME", currency: "BRL", owner_user_id: null, owner_agent_id: null } as unknown as Lead;

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KanbanCardActions lead={LEAD} pipelineId="p-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  estado.permissoes = new Set();
});

describe("o '+' de venda no card do funil", () => {
  it("quem registra venda (agent+) vê o '+'", () => {
    estado.permissoes = new Set(["vendas.registrar", "pipeline.move_card"]);
    renderCard();
    expect(screen.getByTestId("card-registrar-venda")).toBeTruthy();
  });

  it("viewer não vê o '+' (a rota responderia 403)", () => {
    renderCard();
    expect(screen.queryByTestId("card-registrar-venda")).toBeNull();
    // CONTROLE: o card renderizou — o menu de ações está lá.
    expect(screen.getByRole("button", { name: "Ações do negócio" })).toBeTruthy();
  });
});
