/**
 * O QUADRO DE UM FUNIL ARQUIVADO É LEITURA DE VERDADE (#1298, item 1).
 *
 * A página prova a prop; este arquivo prova o COMPORTAMENTO do quadro com ela:
 * sem menu de ações do card, sem caixa de seleção e sem abrir o dossiê — que é
 * onde moram as ações de escrita. O dublê do `KanbanBoard` no outro arquivo
 * deixaria o quadro real sem cobertura nenhuma.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Pipeline, Stage } from "@/lib/kanban/types";

const dossies = vi.hoisted(() => ({ abertos: 0 }));

/**
 * O dnd em jsdom: `DragDropContext` e `Droppable` viram contêineres, e o
 * `Draggable` entrega os `provided` vazios + o `snapshot` que o card lê. O que
 * este arquivo mede não é arrasto — é o que o card OFERECE.
 */
vi.mock("@hello-pangea/dnd", () => ({
  DragDropContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Droppable: ({
    children,
  }: {
    children: (p: object, s: object) => React.ReactNode;
  }) => (
    <div>
      {children(
        { innerRef: () => {}, droppableProps: {}, placeholder: null },
        { isDraggingOver: false },
      )}
    </div>
  ),
  Draggable: ({
    children,
    isDragDisabled,
  }: {
    children: (p: object, s: object) => React.ReactNode;
    isDragDisabled?: boolean;
  }) => (
    <div data-drag-disabled={isDragDisabled ? "sim" : "nao"}>
      {children(
        { innerRef: () => {}, draggableProps: {}, dragHandleProps: null },
        { isDragging: false },
      )}
    </div>
  ),
}));
vi.mock("@/components/kanban/LeadDossier", () => ({
  LeadDossier: () => {
    dossies.abertos += 1;
    return <div data-testid="dossie-aberto" />;
  },
}));
/**
 * O `AuthProvider` inteiro NÃO é dublado campo a campo: o card puxa permissão,
 * organização, moeda e usuário de hooks diferentes do mesmo módulo, e um mock
 * parcial quebra a cada hook novo. O `importOriginal` mantém os outros e troca
 * só o que precisa de contexto.
 */
vi.mock("@/hooks/auth/AuthProvider", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: { id: "u-1" } }),
  usePermission: () => true,
  useActiveOrg: () => ({ orgId: "org-1", role: "admin" }),
  useUser: () => ({ id: "u-1" }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/hooks/inbox/useAssignableAgents", () => ({ useAssignableAgents: () => ({ data: [] }) }));
vi.mock("@/hooks/leads/usePropostaEnviadaDoLead", () => ({
  usePropostaEnviadaDoLead: () => ({ data: null }),
}));
vi.mock("@/hooks/leads/useAtRiskLeads", () => ({ useAtRiskLeads: () => ({ data: null }) }));
vi.mock("@/hooks/leads/useReactivations", () => ({ useReactivations: () => ({ data: [] }) }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(() => new Promise<never>(() => {})), post: vi.fn(), patch: vi.fn() },
}));

const QUADRO = {
  pipeline: { id: "p-1", name: "Comercial 2025", settings: {}, is_archived: true },
  stages: [
    { id: "s-1", name: "Novo", position: 0, is_won: false, is_lost: false, is_archived: false },
  ],
  leads: [
    {
      id: "l-1",
      title: "Negócio antigo",
      stage_id: "s-1",
      position_in_stage: 1000,
      value_cents: null,
      recurring_value_cents: null,
      recurring_period: null,
      currency: null,
      tags: [],
      stage_changed_at: null,
      created_at: "2024-09-01T12:00:00.000Z",
      owner_kind: "user",
      owner_user_id: null,
      owner_agent_id: null,
      owner_agent: null,
      next_action: null,
      score: null,
      status: "open",
      organization_id: "org-1",
      pipeline_id: "p-1",
      custom_fields: {},
    },
  ],
};

/**
 * O quadro real, com os dados vindo por PROP (`stages`/`leads` desligam a
 * consulta interna): é o mesmo caminho da página, sem rede.
 */
async function montarQuadro(somenteLeitura: boolean, leadInicial?: string) {
  dossies.abertos = 0;
  const { KanbanBoard } = await import("@/components/kanban/KanbanBoard");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <KanbanBoard
        pipelineId="p-1"
        pipeline={QUADRO.pipeline as unknown as Pipeline}
        stages={QUADRO.stages as unknown as Stage[]}
        leads={QUADRO.leads as never}
        somenteLeitura={somenteLeitura}
        leadInicial={leadInicial}
      />
    </QueryClientProvider>,
  );
}

describe("o quadro de um funil arquivado (#1298, item 1)", () => {
  it("não oferece o menu de ações do card nem a caixa de seleção", async () => {
    await montarQuadro(true);

    expect(screen.queryByRole("button", { name: "Ações do lead" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    // E o card também não arrasta: a coluna recebeu `isDragDisabled`.
    expect(document.querySelector('[data-drag-disabled="sim"]')).not.toBeNull();
  });

  it("clicar no card não abre o dossiê — que teria ações de escrita", async () => {
    const user = userEvent.setup();
    await montarQuadro(true);

    await user.click(screen.getByRole("button", { name: "Negócio antigo" }));
    expect(dossies.abertos).toBe(0);
  });

  it("o deep link `?lead=` também não abre o dossiê no funil arquivado", async () => {
    await montarQuadro(true, "l-1");
    expect(dossies.abertos).toBe(0);
  });

  it("no funil vivo o deep link `?lead=` abre o dossiê", async () => {
    await montarQuadro(false, "l-1");
    expect(dossies.abertos).toBeGreaterThan(0);
  });

  it("no funil vivo o card continua com menu, caixa e dossiê", async () => {
    const user = userEvent.setup();
    await montarQuadro(false);

    expect(screen.getByRole("button", { name: "Ações do lead" })).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2); // etapa + card
    expect(document.querySelector('[data-drag-disabled="nao"]')).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Negócio antigo" }));
    expect(dossies.abertos).toBe(1);
  });
});
