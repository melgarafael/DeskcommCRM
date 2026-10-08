/**
 * O PONTO DE USO do conserto do #916/#919 — o quadro, não o hook.
 *
 * Quem decide o `expected_updated_at` que vai no fio é
 * `components/kanban/KanbanBoard.tsx` (`handleDragEnd`), lendo `lead.updated_at`
 * da lista que ele mesmo renderiza. O hook só repassa o que recebeu: um teste
 * que para no `useMoveCard` fica verde com esse valor congelado na origem —
 * medido como sabotagem-controle, zero casos vermelhos.
 *
 * Este arquivo fecha a volta inteira, como o operador a faz: arrasta um card,
 * o servidor devolve a versão final, e o SEGUNDO arrasto do MESMO card manda o
 * `updated_at` que veio do primeiro — que é o que impede o 409 "modificado por
 * outro usuário".
 *
 * O arrasto entra pelo `onDragEnd` que o `DragDropContext` recebe (o dnd é
 * dublê aqui): é o mesmo `DropResult` que o gesto do mouse e o do teclado
 * produzem, sem depender de arrastar pixels no jsdom.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardData } from "@/lib/kanban/types";

const post = vi.hoisted(() => vi.fn());
const patch = vi.hoisted(() => vi.fn());
const capturado = vi.hoisted(() => ({
  onDragEnd: null as ((r: unknown) => void) | null,
}));

vi.mock("@hello-pangea/dnd", () => ({
  DragDropContext: ({
    onDragEnd,
    children,
  }: {
    onDragEnd: (r: unknown) => void;
    children: ReactNode;
  }) => {
    capturado.onDragEnd = onDragEnd;
    return <div>{children}</div>;
  },
}));
vi.mock("@/components/kanban/StageColumn", () => ({ StageColumn: () => null }));
vi.mock("@/components/kanban/LeadDossier", () => ({ LeadDossier: () => null }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));
vi.mock("@/hooks/leads/useAtRiskLeads", () => ({ useAtRiskLeads: () => ({ data: null }) }));
vi.mock("@/hooks/leads/useReactivations", () => ({ useReactivations: () => ({ data: [] }) }));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: () => ({ status: "SUBSCRIBED", ultimaEntrega: null }),
}));
vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({
  useRefetchDeSeguranca: () => undefined,
}));
// O GET do board fica PENDENTE de propósito: a janela do #916 é justamente o
// intervalo entre a resposta do move e o refetch do `onSettled` chegar. Um GET
// que responde fecha essa janela e o teste passaria a medir o refetch.
vi.mock("@/lib/api/client", () => ({
  apiClient: { post, patch, get: vi.fn(() => new Promise<never>(() => {})) },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { KanbanBoard } from "@/components/kanban/KanbanBoard";
import { useEditLead, useLoseLead, useWinLead } from "@/hooks/kanban/useUpdateLead";

const PIPELINE = "p-1";
const LEAD = "l-1";
const ANTES = "2026-09-15T12:00:00.000Z";
const DEPOIS_DO_PRIMEIRO = "2026-09-15T12:00:01.500Z";

function quadro(): BoardData {
  return {
    pipeline: { id: PIPELINE, settings: null } as unknown as BoardData["pipeline"],
    stages: [
      { id: "s-1", name: "Novo", position: 0 },
      { id: "s-2", name: "Contato", position: 1 },
    ] as unknown as BoardData["stages"],
    leads: [
      {
        id: LEAD,
        stage_id: "s-1",
        position_in_stage: 1000,
        updated_at: ANTES,
      } as BoardData["leads"][number],
    ],
  };
}

/** O `DropResult` de soltar o card na coluna `s-2`, na primeira posição. */
const soltarEmS2 = {
  draggableId: LEAD,
  source: { droppableId: "s-1", index: 0 },
  destination: { droppableId: "s-2", index: 0 },
  reason: "DROP",
  type: "DEFAULT",
  mode: "FLUID",
};

let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

async function arrastar(): Promise<void> {
  await act(async () => {
    capturado.onDragEnd?.(soltarEmS2);
  });
}

beforeEach(() => {
  post.mockReset();
  patch.mockReset();
  capturado.onDragEnd = null;
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  qc.setQueryData(["board", PIPELINE], quadro());
});

describe("o quadro manda o updated_at do card que ele renderiza", () => {
  it("o primeiro arrasto manda o updated_at que veio do servidor no board", async () => {
    post.mockResolvedValue({
      data: { id: LEAD, stage_id: "s-2", position_in_stage: 500, updated_at: DEPOIS_DO_PRIMEIRO },
    });
    render(<KanbanBoard pipelineId={PIPELINE} />, { wrapper });
    await waitFor(() => expect(capturado.onDragEnd).not.toBeNull());

    await arrastar();

    expect(post).toHaveBeenCalledWith(
      `/api/v1/leads/${LEAD}/move`,
      expect.objectContaining({ stage_id: "s-2", expected_updated_at: ANTES }),
    );
  });

  it("o segundo arrasto do MESMO card manda o updated_at que o primeiro devolveu", async () => {
    post
      .mockResolvedValueOnce({
        data: { id: LEAD, stage_id: "s-2", position_in_stage: 500, updated_at: DEPOIS_DO_PRIMEIRO },
      })
      .mockResolvedValueOnce({
        data: {
          id: LEAD,
          stage_id: "s-2",
          position_in_stage: 250,
          updated_at: "2026-09-15T12:00:03.000Z",
        },
      });
    render(<KanbanBoard pipelineId={PIPELINE} />, { wrapper });
    await waitFor(() => expect(capturado.onDragEnd).not.toBeNull());

    await arrastar();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    // A resposta do primeiro já está no cache — é dela que o quadro lê agora.
    await arrastar();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));

    expect(post).toHaveBeenLastCalledWith(
      `/api/v1/leads/${LEAD}/move`,
      expect.objectContaining({ expected_updated_at: DEPOIS_DO_PRIMEIRO }),
    );
  });
});

/**
 * OS IRMÃOS DO ARRASTO — ganhar, perder e editar (issue #916, segunda metade).
 *
 * O conserto do #919 parou no `useMoveCard`. As outras três mutações do quadro
 * recebiam o lead na resposta e a descartavam, então o 409 continuava alcançável
 * por outro gesto, e por um caminho MAIS provável que arrastar duas vezes: abrir
 * o dossiê, editar o negócio, fechar e arrastar o card. O quadro segue lendo o
 * `updated_at` de antes da edição enquanto o refetch do `onSettled` não chega.
 *
 * O teste mede o que o fio carrega, no ponto de uso — não o que o hook escreve
 * no cache: entre o `setQueryData` do hook e o `expected_updated_at` do arrasto
 * está `KanbanBoard`, que é quem escolhe de onde ler.
 */
const DEPOIS_DA_EDICAO = "2026-09-15T12:00:02.000Z";

async function quadroMontado(): Promise<void> {
  render(<KanbanBoard pipelineId={PIPELINE} />, { wrapper });
  await waitFor(() => expect(capturado.onDragEnd).not.toBeNull());
}

/**
 * Deixa o quadro RE-RENDERIZAR antes do arrasto.
 *
 * `capturado.onDragEnd` é o callback da última renderização, e ele fecha sobre o
 * `data` daquele instante — é assim no produto também (`handleDragEnd` é um
 * `useCallback` com `[data]` nas dependências). Sem este flush o teste mediria o
 * fechamento velho e diria "não gravou" sobre um cache que gravou.
 */
async function quadroRedesenhado(esperado: string): Promise<void> {
  await waitFor(() =>
    expect(
      qc.getQueryData<BoardData>(["board", PIPELINE])!.leads.find((l) => l.id === LEAD)!.updated_at,
    ).toBe(esperado),
  );
  await act(async () => {});
}

describe("mexer no negócio e arrastar em seguida", () => {
  it("depois de EDITAR, o arrasto manda o updated_at que a edição devolveu", async () => {
    patch.mockResolvedValue({
      data: { id: LEAD, stage_id: "s-1", updated_at: DEPOIS_DA_EDICAO },
    });
    post.mockResolvedValue({
      data: { id: LEAD, stage_id: "s-2", position_in_stage: 500, updated_at: "2026-09-15T12:00:09.000Z" },
    });
    await quadroMontado();

    const { result } = renderHook(() => useEditLead(PIPELINE), { wrapper });
    await act(() => result.current.mutateAsync({ leadId: LEAD, patch: { title: "novo" } }));
    await quadroRedesenhado(DEPOIS_DA_EDICAO);

    await arrastar();

    expect(post).toHaveBeenCalledWith(
      `/api/v1/leads/${LEAD}/move`,
      expect.objectContaining({ expected_updated_at: DEPOIS_DA_EDICAO }),
    );
  });

  it("depois de PERDER, o arrasto manda o updated_at que a perda devolveu", async () => {
    post.mockImplementation(async (url: string) =>
      url.endsWith("/lose")
        ? { data: { id: LEAD, stage_id: "s-1", status: "lost", updated_at: DEPOIS_DA_EDICAO } }
        : { data: { id: LEAD, stage_id: "s-2", position_in_stage: 500, updated_at: "2026-09-15T12:00:09.000Z" } },
    );
    await quadroMontado();

    const { result } = renderHook(() => useLoseLead(PIPELINE), { wrapper });
    await act(() => result.current.mutateAsync({ leadId: LEAD, lostReason: "price" }));
    await quadroRedesenhado(DEPOIS_DA_EDICAO);

    await arrastar();

    expect(post).toHaveBeenLastCalledWith(
      `/api/v1/leads/${LEAD}/move`,
      expect.objectContaining({ expected_updated_at: DEPOIS_DA_EDICAO }),
    );
  });

  it("depois de GANHAR, o arrasto manda o updated_at que o ganho devolveu", async () => {
    post.mockImplementation(async (url: string) =>
      url.endsWith("/win")
        ? { data: { id: LEAD, stage_id: "s-1", status: "won", updated_at: DEPOIS_DA_EDICAO } }
        : { data: { id: LEAD, stage_id: "s-2", position_in_stage: 500, updated_at: "2026-09-15T12:00:09.000Z" } },
    );
    await quadroMontado();

    const { result } = renderHook(() => useWinLead(PIPELINE), { wrapper });
    await act(() => result.current.mutateAsync({ leadId: LEAD }));
    await quadroRedesenhado(DEPOIS_DA_EDICAO);

    await arrastar();

    expect(post).toHaveBeenLastCalledWith(
      `/api/v1/leads/${LEAD}/move`,
      expect.objectContaining({ expected_updated_at: DEPOIS_DA_EDICAO }),
    );
  });
});

/**
 * O PONTO DE USO DO #2545 — a `position_in_stage` que o arrasto grava com o
 * FILTRO ligado.
 *
 * O quadro monta o `before`/`after` a partir da lista que ele renderiza, e quem
 * monta a página passa essa lista JÁ FILTRADA (`_client.tsx`,
 * `leads={filteredLeads}`). Aqui as duas listas do produto ficam separadas de
 * propósito: o cache `["board", PIPELINE]` guarda o funil INTEIRO e o
 * `KanbanBoard` recebe só o que o filtro deixa ver. O que se afirma é a régua
 * da issue — a posição gravada não pode ser a de nenhum card da etapa,
 * escondido ou não.
 */
const A_VISIVEL = "card-a";
const OCULTO_B = "card-b";
const OCULTO_C = "card-c";
const D_SOLTO = "card-d";

function card(id: string, stageId: string, pos: number, tags: string[] = []) {
  return {
    id,
    stage_id: stageId,
    position_in_stage: pos,
    updated_at: ANTES,
    tags,
  } as BoardData["leads"][number];
}

function funilInteiro(leads: BoardData["leads"]): BoardData {
  return {
    pipeline: { id: PIPELINE, settings: null } as unknown as BoardData["pipeline"],
    stages: [
      { id: "s-1", name: "Novo", position: 0 },
      { id: "s-2", name: "Contato", position: 1 },
    ] as unknown as BoardData["stages"],
    leads,
  };
}

/**
 * Monta o quadro COM o filtro, como a página faz: o funil inteiro vai para o
 * cache (é dele que o `after` é lido) e só os cards visíveis vão para as props
 * (é deles que o `before` e o `destination.index` são contados).
 */
async function montarComFiltro(funil: BoardData, visiveis: BoardData["leads"]): Promise<void> {
  qc.setQueryData<BoardData>(["board", PIPELINE], funil);
  render(
    <KanbanBoard
      pipelineId={PIPELINE}
      stages={funil.stages}
      leads={visiveis}
      pipeline={funil.pipeline}
    />,
    { wrapper },
  );
  await waitFor(() => expect(capturado.onDragEnd).not.toBeNull());
}

/** O mesmo gesto do mouse, mas com o `DropResult` do caso. */
async function arrastarPara(resultado: unknown): Promise<void> {
  await act(async () => {
    capturado.onDragEnd?.(resultado);
  });
}

type CorpoDoMove = { stage_id: string; position_in_stage: number };

function posicaoGravada(): number {
  const chamadas = post.mock.calls as unknown as Array<[string, CorpoDoMove]>;
  const ultima = chamadas[chamadas.length - 1];
  if (!ultima) throw new Error("o quadro não mandou POST /move nenhum");
  return ultima[1].position_in_stage;
}

/**
 * A régua da issue, escrita como ela escreve: "uma posição que NENHUM outro
 * card da etapa tem". É esta asserção que o pré-fix derruba — a posição gravada
 * é justamente a do card que o filtro escondeu.
 */
function nenhumEmpateNaEtapa(funil: BoardData, stageId: string, pos: number): void {
  const empatados = funil.leads
    .filter((l) => l.stage_id === stageId && l.position_in_stage === pos)
    .map((l) => l.id);
  expect(empatados).toEqual([]);
}

describe("soltar com o filtro ligado não empata a posição com o card escondido", () => {
  it("no fim de outra etapa: grava 1500, não a 2000 do card B escondido", async () => {
    // Etapa s-1 com A(1000, quente), B(2000) e C(3000); o filtro de tag deixa só
    // A. Soltar D no fim da coluna visível dava midpoint(1000, null) = 2000,
    // que é a posição do B — o empate que a issue relata.
    const funil = funilInteiro([
      card(A_VISIVEL, "s-1", 1000, ["quente"]),
      card(OCULTO_B, "s-1", 2000),
      card(OCULTO_C, "s-1", 3000),
      card(D_SOLTO, "s-2", 1000, ["quente"]),
    ]);
    const visiveis = [
      card(A_VISIVEL, "s-1", 1000, ["quente"]),
      card(D_SOLTO, "s-2", 1000, ["quente"]),
    ];
    post.mockResolvedValue({ data: {} });
    await montarComFiltro(funil, visiveis);

    await arrastarPara({
      draggableId: D_SOLTO,
      source: { droppableId: "s-2", index: 0 },
      destination: { droppableId: "s-1", index: 1 },
      reason: "DROP",
      type: "DEFAULT",
      mode: "FLUID",
    });

    nenhumEmpateNaEtapa(funil, "s-1", posicaoGravada());
    expect(posicaoGravada()).toBe(1500);
    expect(post).toHaveBeenCalledWith(
      `/api/v1/leads/${D_SOLTO}/move`,
      expect.objectContaining({ stage_id: "s-1", position_in_stage: 1500 }),
    );
  });

  it("reordenando na mesma etapa até o fim: grava 2500, não a 3000 do card C escondido", async () => {
    // Visíveis A(1000) e B(2000), escondido C(3000). Arrastar A para baixo do B
    // dava midpoint(2000, null) = 3000 — a posição do C.
    const funil = funilInteiro([
      card(A_VISIVEL, "s-1", 1000, ["quente"]),
      card(OCULTO_B, "s-1", 2000),
      card(OCULTO_C, "s-1", 3000),
    ]);
    const visiveis = [card(A_VISIVEL, "s-1", 1000, ["quente"]), card(OCULTO_B, "s-1", 2000)];
    post.mockResolvedValue({ data: {} });
    await montarComFiltro(funil, visiveis);

    await arrastarPara({
      draggableId: A_VISIVEL,
      source: { droppableId: "s-1", index: 0 },
      destination: { droppableId: "s-1", index: 1 },
      reason: "DROP",
      type: "DEFAULT",
      mode: "FLUID",
    });

    nenhumEmpateNaEtapa(funil, "s-1", posicaoGravada());
    expect(posicaoGravada()).toBe(2500);
  });

  it("sem nenhum card escondido a posição é a de sempre (o controle que não pode mudar)", async () => {
    // Visível = funil inteiro: o `after` é null e midpoint(2000, null) = 3000,
    // igualzinho ao de antes do conserto.
    const leads = [
      card(A_VISIVEL, "s-1", 1000),
      card(OCULTO_B, "s-1", 2000),
      card(D_SOLTO, "s-2", 1000),
    ];
    const funil = funilInteiro(leads);
    post.mockResolvedValue({ data: {} });
    await montarComFiltro(funil, leads);

    await arrastarPara({
      draggableId: D_SOLTO,
      source: { droppableId: "s-2", index: 0 },
      destination: { droppableId: "s-1", index: 2 },
      reason: "DROP",
      type: "DEFAULT",
      mode: "FLUID",
    });

    nenhumEmpateNaEtapa(funil, "s-1", posicaoGravada());
    expect(posicaoGravada()).toBe(3000);
  });
});
