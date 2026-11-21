/**
 * ARRASTAR AS ETAPAS DO FUNIL (#4802, item 1) — a coluna muda de lugar pela alça.
 *
 * Antes, a ordem só mudava pelas setas, uma casa por clique: levar a última de
 * oito colunas para o começo eram sete cliques, cada um com um PATCH e uma
 * releitura. O que se prova aqui:
 *
 * 1. soltar a coluna manda UM PATCH com a vizinha da ESQUERDA (`depois_de`),
 *    o mesmo contrato das setas — nunca um número de posição;
 * 2. a conta do vizinho é UMA só (`vizinhoAoSoltar`), e as setas a usam também;
 * 3. a lista mostra a ordem nova enquanto o pedido está em voo (senão a linha
 *    solta volta ao lugar antigo e parece que o arrasto falhou), e a recusa do
 *    servidor devolve a ordem de antes;
 * 4. soltar no mesmo lugar, ou fora da lista, não manda pedido nenhum.
 */
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ApiError } from "@/lib/api/types";
import type { EstadoDoMapeamento, EtapaDoFunil } from "@/hooks/pipelines/useAgentMapping";

const h = vi.hoisted(() => ({
  onDragEnd: null as ((r: unknown) => void) | null,
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
// O arrasto de verdade depende de medir caixas na tela, e o jsdom não mede nada.
// O que importa aqui é o que a tela faz com o `DropResult` — e ele é capturado.
vi.mock("@hello-pangea/dnd", () => ({
  DragDropContext: ({
    onDragEnd,
    children,
  }: {
    onDragEnd: (r: unknown) => void;
    children: ReactNode;
  }) => {
    h.onDragEnd = onDragEnd;
    return <>{children}</>;
  },
  Droppable: ({ children }: { children: (p: Record<string, unknown>) => ReactNode }) =>
    children({ innerRef: () => {}, droppableProps: {}, placeholder: null }),
  Draggable: ({
    children,
  }: {
    children: (p: Record<string, unknown>, s: Record<string, unknown>) => ReactNode;
  }) =>
    children({ innerRef: () => {}, draggableProps: {}, dragHandleProps: {} }, { isDragging: false }),
}));

import { apiClient } from "@/lib/api/client";
import { etapasComAMovida } from "@/hooks/pipelines/useStages";
import { StagesSection, vizinhoAoMover, vizinhoAoSoltar } from "./_stages";

window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const PIPE = "22222222-2222-4222-8222-222222222222";

const ETAPAS: EtapaDoFunil[] = [
  { id: "e1", name: "Novo contato", is_won: false, is_lost: false },
  { id: "e2", name: "Orçamento enviado", is_won: false, is_lost: false },
  { id: "e3", name: "Negociação", is_won: false, is_lost: false },
  { id: "e4", name: "Fechado", is_won: true, is_lost: false },
  { id: "e5", name: "Perdido", is_won: false, is_lost: true },
];

const VAZIO = {
  new: null,
  contacted: null,
  qualifying: null,
  qualified: null,
  negotiating: null,
  won: null,
  lost: null,
};

const estado = (etapas: EtapaDoFunil[] = ETAPAS): EstadoDoMapeamento => ({
  etapas,
  mapeamento: { ...VAZIO },
});

function montar() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <StagesSection pipelineId={PIPE} ancoraMapeamento={`mapeamento-${PIPE}`} />
    </QueryClientProvider>,
  );
}

function soltar(de: number, para: number | null) {
  act(() => {
    h.onDragEnd?.({
      draggableId: ETAPAS[de]!.id,
      source: { droppableId: `etapas-do-funil-${PIPE}`, index: de },
      destination:
        para === null ? null : { droppableId: `etapas-do-funil-${PIPE}`, index: para },
      reason: "DROP",
      type: "DEFAULT",
      mode: "FLUID",
    });
  });
}

/** A ordem das linhas como a tela as desenha. */
const ordemNaTela = () =>
  screen
    .getAllByTestId(/^etapa-e\d$/)
    .map((li) => li.getAttribute("data-testid")!.replace("etapa-", ""));

beforeEach(() => {
  vi.clearAllMocks();
  h.onDragEnd = null;
  vi.mocked(apiClient.get).mockImplementation(async (rota: string) =>
    String(rota).includes("/agent-mapping") ? { data: estado() } : { data: null },
  );
});

describe("vizinhoAoSoltar — a coluna da esquerda depois de soltar", () => {
  it("levar a última para o começo a deixa sem vizinha à esquerda", () => {
    expect(vizinhoAoSoltar(ETAPAS, 4, 0)).toBeNull();
  });

  it("levar a primeira para o fim a deixa depois da última", () => {
    expect(vizinhoAoSoltar(ETAPAS, 0, 4)).toBe("e5");
  });

  it("descer duas casas a deixa depois de quem estava duas casas abaixo", () => {
    expect(vizinhoAoSoltar(ETAPAS, 1, 3)).toBe("e4");
  });

  it("subir duas casas a deixa depois de quem estava três casas acima", () => {
    expect(vizinhoAoSoltar(ETAPAS, 4, 2)).toBe("e2");
  });

  it("as setas são o arrasto de uma casa — a mesma conta", () => {
    for (let i = 0; i < ETAPAS.length; i += 1) {
      if (i > 0) expect(vizinhoAoMover(ETAPAS, i, "subir")).toBe(vizinhoAoSoltar(ETAPAS, i, i - 1));
      if (i < ETAPAS.length - 1) {
        expect(vizinhoAoMover(ETAPAS, i, "descer")).toBe(vizinhoAoSoltar(ETAPAS, i, i + 1));
      }
    }
  });
});

describe("etapasComAMovida — a ordem que o PATCH vai gravar", () => {
  const ids = (etapas: EtapaDoFunil[]) => etapas.map((e) => e.id);

  it("põe a etapa logo depois da vizinha, e no começo com `null`", () => {
    expect(ids(etapasComAMovida(ETAPAS, "e1", "e3"))).toEqual(["e2", "e3", "e1", "e4", "e5"]);
    expect(ids(etapasComAMovida(ETAPAS, "e5", null))).toEqual(["e5", "e1", "e2", "e3", "e4"]);
    expect(ids(etapasComAMovida(ETAPAS, "e2", "e5"))).toEqual(["e1", "e3", "e4", "e5", "e2"]);
  });

  it("concorda com `vizinhoAoSoltar` em todo par de casas", () => {
    for (let de = 0; de < ETAPAS.length; de += 1) {
      for (let para = 0; para < ETAPAS.length; para += 1) {
        const esperado = ids(ETAPAS);
        const [movida] = esperado.splice(de, 1);
        esperado.splice(para, 0, movida!);
        const depoisDe = vizinhoAoSoltar(ETAPAS, de, para);
        expect(ids(etapasComAMovida(ETAPAS, ETAPAS[de]!.id, depoisDe))).toEqual(esperado);
      }
    }
  });

  it("vizinha ou etapa fora da lista devolve a MESMA lista — a API recusa, a tela não inventa", () => {
    expect(etapasComAMovida(ETAPAS, "e1", "sumiu")).toBe(ETAPAS);
    expect(etapasComAMovida(ETAPAS, "sumiu", "e1")).toBe(ETAPAS);
    expect(etapasComAMovida(ETAPAS, "e1", "e1")).toBe(ETAPAS);
  });
});

describe("StagesSection — arrastar a coluna pela alça", () => {
  it("cada linha tem uma alça que diz o que ela faz", async () => {
    montar();
    await screen.findByTestId("nome-e1");
    expect(screen.getByTestId("arrastar-e3")).toHaveAttribute(
      "aria-label",
      "Arrastar para reordenar «Negociação»",
    );
  });

  it("soltar a última coluna no começo manda UM PATCH com `depois_de: null`", async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { etapas: [] } });
    montar();
    await screen.findByTestId("nome-e1");

    soltar(4, 0);

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiClient.patch).mock.calls[0]).toEqual([
      `/api/v1/pipelines/${PIPE}/stages/e5`,
      { depois_de: null },
    ]);
  });

  it("soltar a segunda coluna duas casas abaixo a manda para depois da quarta", async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { etapas: [] } });
    montar();
    await screen.findByTestId("nome-e1");

    soltar(1, 3);

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiClient.patch).mock.calls[0]![1]).toEqual({ depois_de: "e4" });
  });

  it("a linha fica onde foi solta enquanto o pedido está em voo", async () => {
    let responder: (v: unknown) => void = () => {};
    vi.mocked(apiClient.patch).mockImplementation(
      () => new Promise((resolve) => (responder = resolve)),
    );
    montar();
    await screen.findByTestId("nome-e1");
    expect(ordemNaTela()).toEqual(["e1", "e2", "e3", "e4", "e5"]);

    soltar(0, 2);

    await waitFor(() => expect(ordemNaTela()).toEqual(["e2", "e3", "e1", "e4", "e5"]));
    expect(apiClient.patch).toHaveBeenCalledTimes(1);

    // O servidor gravou: a releitura traz a ordem dele, que é a mesma.
    vi.mocked(apiClient.get).mockImplementation(async (rota: string) =>
      String(rota).includes("/agent-mapping")
        ? { data: estado([ETAPAS[1]!, ETAPAS[2]!, ETAPAS[0]!, ETAPAS[3]!, ETAPAS[4]!]) }
        : { data: null },
    );
    await act(async () => responder({ data: { etapas: [] } }));
    await waitFor(() => expect(ordemNaTela()).toEqual(["e2", "e3", "e1", "e4", "e5"]));
  });

  it("a recusa do servidor devolve a ordem de antes e diz o porquê", async () => {
    vi.mocked(apiClient.patch).mockRejectedValue(
      new ApiError(
        409,
        "state_conflict",
        undefined,
        "req-arrastar",
        "As colunas deste funil estão empatadas na ordenação. Recarregue a página e mova a etapa para outro lugar.",
      ),
    );
    montar();
    await screen.findByTestId("nome-e1");

    soltar(0, 2);

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(ordemNaTela()).toEqual(["e1", "e2", "e3", "e4", "e5"]));
    expect(await screen.findByText(/empatadas na ordenação/)).toBeInTheDocument();
  });

  it("soltar no mesmo lugar, ou fora da lista, não manda pedido nenhum", async () => {
    montar();
    await screen.findByTestId("nome-e1");

    soltar(2, 2);
    soltar(2, null);

    expect(apiClient.patch).not.toHaveBeenCalled();
    expect(ordemNaTela()).toEqual(["e1", "e2", "e3", "e4", "e5"]);
  });
});
