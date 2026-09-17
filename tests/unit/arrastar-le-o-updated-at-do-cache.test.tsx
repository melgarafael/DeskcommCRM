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
