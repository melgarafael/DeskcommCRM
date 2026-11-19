/**
 * O ARRASTE NÃO RELÊ O FUNIL INTEIRO (#4788) — medido, não descrito.
 *
 * O desenho do quadro já foi resolvido antes desta issue (o PR #4801 levou o
 * número de `Draggable` de ~2.545 para ~290). O que continuava caro era a REDE:
 * cada card solto invalidava o quadro inteiro (`useMoveCard.onSettled`) e cada
 * evento de realtime invalidava de novo, sem debounce (`useBoard.onChange`).
 * Num funil com milhares de negócios, isso é a rota do quadro — paginada e
 * enriquecida card a card — saindo a cada gesto.
 *
 * As contagens abaixo são a régua da entrega: antes, 1 invalidação por arraste
 * e 10 por rajada de 10 eventos; depois, 0 e 1. Elas são medidas no
 * `QueryClient` de verdade (`invalidateQueries` é o dublê), não num contador
 * que o próprio teste inventa.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import type { BoardData } from "@/lib/kanban/types";

const post = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
const canal = vi.hoisted(() => ({ onChange: null as ((p: unknown) => void) | null }));

vi.mock("@/lib/api/client", () => ({ apiClient: { post, get, patch: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (o: { onChange: (p: unknown) => void }) => {
    canal.onChange = o.onChange;
    return { status: "SUBSCRIBED", ultimaEntrega: { current: null } };
  },
}));
vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({
  useRefetchDeSeguranca: () => undefined,
}));

import {
  JANELA_DA_RAJADA_MS,
  TETO_DA_RAJADA_MS,
  useBoard,
} from "@/hooks/kanban/useBoard";
import { useMoveCard } from "@/hooks/kanban/useMoveCard";
import { limparEcosLocais, marcarEcoLocal } from "@/lib/kanban/local-echo";

const PIPELINE = "p-1";
const OUTRO_FUNIL = "p-2";
const LEAD = "l-1";
const ANTES = "2026-09-15T12:00:00.000Z";

function quadro(): BoardData {
  return {
    pipeline: { id: PIPELINE, settings: null } as unknown as BoardData["pipeline"],
    stages: [
      { id: "s-1", name: "Novo", position: 0 },
      { id: "s-2", name: "Contato", position: 1 },
    ] as unknown as BoardData["stages"],
    leads: [
      { id: LEAD, stage_id: "s-1", position_in_stage: 1000, updated_at: ANTES },
    ] as unknown as BoardData["leads"],
  };
}

/** O payload do `postgres_changes`, como o canal o entrega. */
function evento(leadId: string, pipelineId = PIPELINE) {
  return { new: { id: leadId, pipeline_id: pipelineId }, old: {} };
}

let qc: QueryClient;
let invalidar: ReturnType<typeof vi.spyOn>;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

function cardNoCache(): BoardData["leads"][number] {
  return qc.getQueryData<BoardData>(["board", PIPELINE])!.leads.find((l) => l.id === LEAD)!;
}

beforeEach(() => {
  post.mockReset();
  get.mockReset();
  canal.onChange = null;
  limparEcosLocais();
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  qc.setQueryData(["board", PIPELINE], quadro());
  invalidar = vi.spyOn(qc, "invalidateQueries");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("um arraste", () => {
  it("muda o card de coluna ANTES da resposta, sem invalidar o quadro", async () => {
    let liberar!: (v: unknown) => void;
    post.mockImplementation(
      () =>
        new Promise((resolve) => {
          liberar = resolve;
        }),
    );

    const { result } = renderHook(() => useMoveCard(PIPELINE), { wrapper });

    let emVoo!: Promise<unknown>;
    await act(async () => {
      emVoo = result.current.mutateAsync({
        leadId: LEAD,
        stageId: "s-2",
        positionInStage: 1500,
        expectedUpdatedAt: ANTES,
      });
      await Promise.resolve();
    });

    // AINDA SEM RESPOSTA: o card já está na coluna de destino (otimista).
    expect(cardNoCache().stage_id).toBe("s-2");
    expect(invalidar).not.toHaveBeenCalled();

    await act(async () => {
      liberar({
        data: {
          id: LEAD,
          stage_id: "s-2",
          position_in_stage: 1500,
          updated_at: "2026-09-15T12:00:01.000Z",
        },
      });
      await emVoo;
    });

    // DEPOIS DA RESPOSTA: nenhuma releitura do funil — a resposta do servidor
    // já foi fundida no card e é ela que o próximo arrasto lê.
    expect(invalidar).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    expect(cardNoCache().updated_at).toBe("2026-09-15T12:00:01.000Z");
    expect(qc.getQueryState(["board", PIPELINE])!.fetchStatus).not.toBe("fetching");
  });

  it("a resposta com etapa DIFERENTE da otimista corrige a tela", async () => {
    // O servidor recusou a etapa otimista (regra de entrada / reabertura) e
    // devolveu o card na etapa de origem: a tela tem de voltar junto.
    post.mockResolvedValue({
      data: {
        id: LEAD,
        stage_id: "s-1",
        position_in_stage: 1000,
        updated_at: "2026-09-15T12:00:02.000Z",
      },
    });

    const { result } = renderHook(() => useMoveCard(PIPELINE), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        leadId: LEAD,
        stageId: "s-2",
        positionInStage: 1500,
        expectedUpdatedAt: ANTES,
      });
    });

    expect(cardNoCache().stage_id).toBe("s-1");
    expect(cardNoCache().updated_at).toBe("2026-09-15T12:00:02.000Z");
    expect(invalidar).not.toHaveBeenCalled();
  });

  // Erro ambíguo: a rota pode ter gravado antes de a resposta se perder. O
  // snapshot devolve o card à coluna antiga, e o evento de realtime desse lead
  // cai na marca de eco — só a releitura conserta a tela.
  it.each([
    ["rede caída", new TypeError("Failed to fetch")],
    ["5xx", new ApiError(502, "bad_gateway", undefined, "req-1")],
  ])("erro de %s devolve o snapshot e relê o quadro", async (_nome, erro) => {
    post.mockRejectedValue(erro);

    const { result } = renderHook(() => useMoveCard(PIPELINE), { wrapper });
    await act(async () => {
      await result.current
        .mutateAsync({ leadId: LEAD, stageId: "s-2", positionInStage: 1500, expectedUpdatedAt: ANTES })
        .catch(() => undefined);
    });

    expect(cardNoCache().stage_id).toBe("s-1");
    expect(invalidar).toHaveBeenCalledTimes(1);
  });
});

describe("realtime do quadro", () => {
  beforeEach(() => {
    get.mockResolvedValue({ data: quadro() });
  });

  /** Monta o quadro desligado da rede: o que se mede aqui é a CONTAGEM. */
  function montarQuadro() {
    renderHook(() => useBoard(PIPELINE, null, { enabled: false }), { wrapper });
    expect(canal.onChange).not.toBeNull();
    return canal.onChange!;
  }

  it("10 eventos em 300 ms viram UMA reconciliação", async () => {
    vi.useFakeTimers();
    const onChange = montarQuadro();

    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        onChange(evento(`l-${i + 10}`));
        vi.advanceTimersByTime(30);
      });
    }
    // A janela só fecha depois do ÚLTIMO evento do lote.
    expect(invalidar).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(JANELA_DA_RAJADA_MS);
    });

    expect(invalidar).toHaveBeenCalledTimes(1);
  });

  it("um evento sozinho gera uma reconciliação", async () => {
    vi.useFakeTimers();
    const onChange = montarQuadro();

    await act(async () => {
      onChange(evento("l-20"));
      vi.advanceTimersByTime(JANELA_DA_RAJADA_MS);
    });

    expect(invalidar).toHaveBeenCalledTimes(1);
  });

  it("evento de OUTRO funil não reconcilia este quadro", async () => {
    vi.useFakeTimers();
    const onChange = montarQuadro();

    await act(async () => {
      onChange(evento("l-21", OUTRO_FUNIL));
      vi.advanceTimersByTime(TETO_DA_RAJADA_MS);
    });

    expect(invalidar).not.toHaveBeenCalled();
  });

  it("o eco do MEU arraste não relê o funil", async () => {
    vi.useFakeTimers();
    const onChange = montarQuadro();
    // O move marca o lead antes de escrever (lib/kanban/local-echo.ts): o
    // evento que volta pelo canal é a minha própria ação.
    marcarEcoLocal("l-22");

    await act(async () => {
      onChange(evento("l-22"));
      vi.advanceTimersByTime(TETO_DA_RAJADA_MS);
    });

    expect(invalidar).not.toHaveBeenCalled();
  });

  it("rajada CONTÍNUA não morre de fome (o teto dispara mesmo sob tempestade)", async () => {
    vi.useFakeTimers();
    const onChange = montarQuadro();

    // Um evento a cada 100 ms por 1,5 s: sem teto, o debounce seria adiado
    // para sempre e o quadro nunca acompanharia o servidor.
    for (let i = 0; i < 15; i += 1) {
      await act(async () => {
        onChange(evento(`l-${i + 30}`));
        vi.advanceTimersByTime(100);
      });
    }

    expect(invalidar.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(invalidar.mock.calls.length).toBeLessThan(15);
  });
});
