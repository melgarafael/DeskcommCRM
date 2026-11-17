/**
 * Funil rápido (#4788), a COLUNA e o menu do card. Mede:
 *
 * 1. Colunas de ganho e perda desenham 50 cards e um "Mostrar mais"; o contador
 *    segue o total; as abertas desenham todos.
 * 2. O card do dossiê aberto (`?lead=`) aparece mesmo além do corte, e continua
 *    na tela quando o dossiê fecha.
 * 3. Mudar `isDraggingOver` da coluna não redesenha nenhum card; um pulso
 *    redesenha só o card dele; o relógio de minuto redesenha os cards e o tempo
 *    na etapa anda sem mudança no negócio.
 * 4. Os diálogos do menu do card não existem fechados e montam ao abrir pelo menu.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Stage } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";

const h = vi.hoisted(() => ({
  renders: new Map<string, number>(),
  horas: new Map<string, number | null>(),
  arrastandoPorCima: [] as Array<(v: boolean) => void>,
  montados: { perda: 0, mover: 0, editar: 0 },
}));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@hello-pangea/dnd", async () => {
  const React = await import("react");
  return {
    DragDropContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    // O Droppable de verdade chama a função filha de novo quando
    // `isDraggingOver` muda — sem redesenhar a coluna. O dublê faz o mesmo: o
    // estado mora nele.
    Droppable: ({ children }: { children: (p: object, s: object) => ReactNode }) => {
      const [over, setOver] = React.useState(false);
      h.arrastandoPorCima.push(setOver);
      return (
        <>
          {children(
            { innerRef: () => {}, droppableProps: {}, placeholder: null },
            { isDraggingOver: over },
          )}
        </>
      );
    },
  };
});
vi.mock("@/components/kanban/KanbanCard", () => ({
  KanbanCard: ({ lead, card }: { lead: { id: string }; card: { hoursInStage: number | null } }) => {
    h.renders.set(lead.id, (h.renders.get(lead.id) ?? 0) + 1);
    h.horas.set(lead.id, card.hoursInStage);
    return <div data-testid="card" data-id={lead.id} />;
  },
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: vi.fn(), get: vi.fn(), patch: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ usePermission: () => true }));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useWinLead: () => ({ mutate: vi.fn(), isPending: false }),
  useEditLead: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/kanban/useBulkAction", () => ({
  useBulkAction: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/kanban/usePropostaEnviadaDoLead", () => ({
  usePropostaEnviadaDoLead: () => ({ data: undefined }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({
  useAssignableAgents: () => ({ data: [] }),
}));
vi.mock("@/components/kanban/LoseLeadDialog", () => ({
  LoseLeadDialog: () => {
    h.montados.perda += 1;
    return <div data-testid="dialogo-perda" />;
  },
}));
vi.mock("@/components/kanban/MoveToOtherPipelineDialog", () => ({
  MoveToOtherPipelineDialog: () => {
    h.montados.mover += 1;
    return <div data-testid="dialogo-mover" />;
  },
}));
vi.mock("@/components/kanban/EditLeadDialog", () => ({
  EditLeadDialog: () => {
    h.montados.editar += 1;
    return <div data-testid="dialogo-editar" />;
  },
}));

import { KanbanCardActions } from "@/components/kanban/KanbanCardActions";
import { StageColumn } from "@/components/kanban/StageColumn";

function etapa(over: Partial<Stage>): Stage {
  return {
    id: "s-perdido",
    pipeline_id: "p-1",
    name: "Perdido",
    position: 9,
    color: null,
    is_won: false,
    is_lost: false,
    ...over,
  } as unknown as Stage;
}

function negocios(n: number, stageId: string): Lead[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `l-${String(i).padStart(4, "0")}`,
    title: `Negócio ${i}`,
    stage_id: stageId,
    position_in_stage: (i + 1) * 1000,
    value_cents: null,
    currency: null,
    tags: [],
  })) as unknown as Lead[];
}

function coluna(stage: Stage, leads: Lead[], extra: Partial<Parameters<typeof StageColumn>[0]> = {}) {
  return <StageColumn stage={stage} leads={leads} pipelineId="p-1" {...extra} />;
}

beforeEach(() => {
  h.renders.clear();
  h.arrastandoPorCima.length = 0;
  h.montados = { perda: 0, mover: 0, editar: 0 };
});
afterEach(cleanup);

describe("ganho e perda de 50 em 50", () => {
  it("coluna de perda com 120 negócios desenha 50, conta 120 e mostra mais 50 por clique", async () => {
    const user = userEvent.setup();
    render(coluna(etapa({ is_lost: true }), negocios(120, "s-perdido")));

    expect(screen.getAllByTestId("card")).toHaveLength(50);
    expect(screen.getByText("120")).toBeTruthy(); // o contador da coluna é o total
    const botao = screen.getByTestId("mostrar-mais-da-coluna");
    expect(botao.textContent).toBe("Mostrar mais 50");

    await user.click(botao);
    expect(screen.getAllByTestId("card")).toHaveLength(100);
    expect(screen.getByTestId("mostrar-mais-da-coluna").textContent).toBe("Mostrar mais 20");

    await user.click(screen.getByTestId("mostrar-mais-da-coluna"));
    expect(screen.getAllByTestId("card")).toHaveLength(120);
    expect(screen.queryByTestId("mostrar-mais-da-coluna")).toBeNull();
  });

  it("selecionar a etapa marca a coluna inteira, não só os mostrados", async () => {
    const user = userEvent.setup();
    const onSelectMany = vi.fn();
    render(coluna(etapa({ is_lost: true }), negocios(120, "s-perdido"), { onSelectMany }));
    await user.click(screen.getByRole("checkbox", { name: "Selecionar todos em Perdido" }));
    expect(onSelectMany).toHaveBeenCalledTimes(1);
    expect(onSelectMany.mock.calls[0]![0]).toHaveLength(120);
    expect(onSelectMany.mock.calls[0]![1]).toBe(true);
  });

  it("coluna de ganho também corta", () => {
    render(coluna(etapa({ id: "s-ganho", name: "Ganho", is_won: true }), negocios(80, "s-ganho")));
    expect(screen.getAllByTestId("card")).toHaveLength(50);
  });

  it("coluna aberta desenha todos, sem botão", () => {
    render(coluna(etapa({ id: "s-aberta", name: "Negociação" }), negocios(120, "s-aberta")));
    expect(screen.getAllByTestId("card")).toHaveLength(120);
    expect(screen.queryByTestId("mostrar-mais-da-coluna")).toBeNull();
  });

  it("o negócio do dossiê aberto aparece além do corte e continua na tela quando o dossiê fecha", () => {
    const stage = etapa({ is_lost: true });
    const leads = negocios(120, "s-perdido");
    const { rerender } = render(coluna(stage, leads, { abertoId: "l-0079" }));
    expect(screen.getAllByTestId("card")).toHaveLength(80);
    expect(screen.getAllByTestId("card").at(-1)?.getAttribute("data-id")).toBe("l-0079");

    rerender(coluna(stage, leads, { abertoId: null }));
    const cards = screen.getAllByTestId("card");
    expect(cards).toHaveLength(80); // não volta a 50 de baixo do cursor
    expect(cards.at(-1)?.getAttribute("data-id")).toBe("l-0079");
  });
});

describe("arrastar por cima da coluna não redesenha os cards", () => {
  it("mudar isDraggingOver não renderiza nenhum card de novo", () => {
    render(coluna(etapa({ is_lost: true }), negocios(120, "s-perdido")));
    const antes = [...h.renders.values()].reduce((a, b) => a + b, 0);
    expect(antes).toBe(50);

    act(() => h.arrastandoPorCima.at(-1)!(true));
    act(() => h.arrastandoPorCima.at(-1)!(false));
    act(() => h.arrastandoPorCima.at(-1)!(true));

    const depois = [...h.renders.values()].reduce((a, b) => a + b, 0);
    expect(depois).toBe(antes); // antes desta mudança: +50 por mudança
  });

  it("um pulso redesenha só o card dele (controle: a medida enxerga um redesenho)", () => {
    const stage = etapa({ id: "s-aberta", name: "Negociação" });
    const leads = negocios(30, "s-aberta");
    const { rerender } = render(coluna(stage, leads, { pulses: new Map() }));
    h.renders.clear();
    rerender(coluna(stage, leads, { pulses: new Map([["l-0003", 1]]) }));
    expect([...h.renders.entries()]).toEqual([["l-0003", 1]]);
  });
});

describe("o tempo na etapa anda com o relógio, sem mudança no negócio", () => {
  afterEach(() => vi.useRealTimers());

  it("depois de uma hora de tiques, o card mede uma hora a mais", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
    const stage = etapa({ id: "s-aberta", name: "Negociação" });
    const leads = negocios(3, "s-aberta").map((l) => ({
      ...l,
      stage_changed_at: "2026-11-16T10:00:00Z",
    })) as Lead[];

    render(coluna(stage, leads));
    expect(h.horas.get("l-0000")).toBe(2);
    h.renders.clear();

    // Os mesmos objetos de negócio: só o relógio anda.
    act(() => vi.advanceTimersByTime(60 * 60_000));

    expect(h.horas.get("l-0000")).toBe(3);
    expect(h.renders.get("l-0000")).toBeGreaterThan(0);
  });
});

describe("diálogos do menu do card", () => {
  const LEAD = {
    id: "l-1",
    title: "Proposta",
    stage_id: "s-1",
    owner_user_id: null,
    owner_agent_id: null,
  } as unknown as Lead;

  function renderAcoes() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <div className="group">
          <KanbanCardActions lead={LEAD} pipelineId="p-1" />
        </div>
      </QueryClientProvider>,
    );
  }

  it("fechados, os três diálogos não montam", () => {
    renderAcoes();
    expect(h.montados).toEqual({ perda: 0, mover: 0, editar: 0 });
  });

  it("abrir pelo menu monta só o diálogo escolhido", async () => {
    const user = userEvent.setup();
    renderAcoes();
    await user.click(screen.getByRole("button", { name: "Ações do negócio" }));
    await user.click(await screen.findByRole("menuitem", { name: "Editar" }));
    expect(await screen.findByTestId("dialogo-editar")).toBeTruthy();
    expect(h.montados.perda).toBe(0);
    expect(h.montados.mover).toBe(0);

    await user.click(screen.getByRole("button", { name: "Ações do negócio" }));
    await user.click(await screen.findByRole("menuitem", { name: "Marcar como perdido" }));
    expect(await screen.findByTestId("dialogo-perda")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Ações do negócio" }));
    await user.click(await screen.findByRole("menuitem", { name: "Levar para outro funil" }));
    expect(await screen.findByTestId("dialogo-mover")).toBeTruthy();
  });
});
