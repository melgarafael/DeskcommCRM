import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AS DUAS LACUNAS QUE SOBRARAM DA #4508.
 *
 * O retry e o timeout do caminho principal já estavam na `main` (PRs #4512 e
 * #4695). Faltava:
 *
 *   1. o `signal` de cancelamento CHEGAR ao `fetch` do GET da lista — o
 *      react-query já tinha o sinal, e a lista não o repassava, então sair da
 *      tela (ou trocar de filtro) deixava a requisição em voo até o timeout de
 *      10 s para depois descartar a resposta;
 *   2. o rastro de retry: `git grep request_retried` devolvia ZERO na `main`.
 *
 * O que este arquivo trava:
 *
 *   a) cancelar a lista no meio aborta o `fetch` REAL da lista, a consulta
 *      rejeita e a resposta velha que chega depois NÃO é aplicada;
 *   b) no cliente, abortar no meio rejeita com `AbortError` e não repete;
 *   c) 503 seguido de 200 produz UM `request_retried` com tentativa 2;
 *   d) 200 direto não produz registro nenhum;
 *   e) 503 que não passa não vira retry infinito: três tentativas, dois
 *      registros (2 e 3) — os limites da `main` continuam os mesmos;
 *   f) o timeout também não mudou: 10 s por tentativa, três tentativas.
 */

vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: () => ({ status: "SUBSCRIBED", ultimaEntrega: { current: null } }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
}));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({
  useAutomaticoAtivo: () => ({ data: false }),
}));
vi.mock("@/components/inbox/ConversationListItem", () => ({
  ConversationListItem: ({ conversation }: { conversation: { id: string } }) => (
    <div data-testid="linha">{conversation.id}</div>
  ),
}));
vi.mock("@/hooks/inbox/useMarcarComoExemplo", () => ({
  useMarcarComoExemplo: () => ({ alternar: () => undefined, salvando: false }),
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: () => undefined }));

const { useConversationsRealtime } = await import("@/hooks/inbox/useConversationsRealtime");
const { ConversationList } = await import("@/components/inbox/ConversationList");
const { apiClient } = await import("@/lib/api/client");

const FILTROS = { status: "open" as const };

function Inbox() {
  const q = useConversationsRealtime(FILTROS, "org-1");
  return (
    <ConversationList listQuery={q} filters={FILTROS} selectedId={null} onSelect={() => undefined} />
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A lista com N conversas, como a rota devolve. */
function listaDe(ids: string[]): Response {
  return jsonResponse(200, {
    data: ids.map((id) => ({ id, status: "open" })),
    meta: { has_more: false },
  });
}

/** A configuração REAL do app (`lib/query/client.ts`). */
function novoCliente() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false, retry: false },
    },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
let logSpy: ReturnType<typeof vi.spyOn>;

/** As linhas `request_retried` que o cliente escreveu neste teste. */
function registros(): Array<Record<string, unknown>> {
  return logSpy.mock.calls
    .map((args: unknown[]) => {
      const [linha] = args as [unknown];
      if (typeof linha !== "string") return null;
      try {
        return JSON.parse(linha) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter(
      (l: Record<string, unknown> | null): l is Record<string, unknown> =>
        l !== null && l.msg === "request_retried",
    );
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  logSpy.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("1. o cancelamento de quem chamou chega ao fetch da lista", () => {
  it("a) abortar a lista no meio aborta o fetch e a resposta velha não é aplicada", async () => {
    let responderVelha: (r: Response) => void = () => undefined;
    let capturado: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      capturado = init?.signal ?? undefined;
      // O dublê IGNORA o abort de propósito: queremos ver o cliente recusando
      // entregar a resposta que chegou depois do cancelamento — e não o dublê
      // fingindo que a rede desistiu por nós.
      return new Promise<Response>((resolve) => {
        responderVelha = resolve;
      });
    });

    const qc = novoCliente();
    render(
      <QueryClientProvider client={qc}>
        <Inbox />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(capturado).toBeDefined());
    expect(capturado?.aborted).toBe(false);

    // Trocar de tela/filtro é isto: o react-query cancela a consulta em voo.
    await act(async () => {
      await qc.cancelQueries({ queryKey: ["conversations"] }).catch(() => undefined);
    });

    expect(capturado?.aborted, "o signal do chamador tinha de chegar ao fetch").toBe(true);

    // A resposta VELHA chega depois do cancelamento.
    await act(async () => {
      responderVelha(listaDe(["conv-velha"]));
      await Promise.resolve();
    });

    expect(screen.queryByTestId("linha")).not.toBeInTheDocument();
    expect(qc.getQueryData(["conversations"])).toBeUndefined();
  });
});

describe("2. abortar no cliente rejeita e não repete", () => {
  it("b) aborto no meio voa como AbortError, sem segunda tentativa e sem request_retried", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const sinal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        sinal?.addEventListener("abort", () =>
          reject(sinal.reason ?? new DOMException("cancelada", "AbortError")),
        );
      });
    });

    const ac = new AbortController();
    const pedido = apiClient.get("/api/v1/conversations?limit=50", { signal: ac.signal });
    const falha = expect(pedido).rejects.toMatchObject({ name: "AbortError" });

    await Promise.resolve();
    ac.abort(new DOMException("cancelada", "AbortError"));

    await falha;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(registros()).toHaveLength(0);
  });
});

describe("3. o retry conta que aconteceu, com o nome estável", () => {
  it("c) 503 seguido de 200: um request_retried, tentativa 2, método e rota lógica", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(503, { error: { code: "service_unavailable", message: "fora" } }),
      )
      .mockResolvedValueOnce(listaDe([]));

    const resposta = await apiClient.get<{ data: unknown[] }>(
      "/api/v1/conversations/3f2a1c4e-1111-4222-8333-44b5c6d7e8f9?search=maria&limit=50",
    );
    expect(resposta).toEqual({ data: [], meta: { has_more: false } });

    const linhas = registros();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      msg: "request_retried",
      evento: "request_retried",
      metodo: "GET",
      rota: "/api/v1/conversations/:id",
      tentativa: 2,
      status: 503,
    });
    // Rota lógica não leva o que a pessoa digitou nem o id da conversa.
    expect(JSON.stringify(linhas[0])).not.toContain("maria");
    expect(JSON.stringify(linhas[0])).not.toContain("3f2a1c4e");
  });

  it("d) 200 direto não produz request_retried nenhum", async () => {
    fetchMock.mockResolvedValueOnce(listaDe([]));
    await apiClient.get("/api/v1/conversations?limit=50");
    expect(registros()).toHaveLength(0);
  });

  it("e) 503 que não passa: três tentativas e dois registros (2 e 3) — o limite não mudou", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(503, { error: { code: "service_unavailable", message: "fora" } }),
    );

    await expect(apiClient.get("/api/v1/conversations?limit=50")).rejects.toMatchObject({
      status: 503,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(registros().map((l) => l.tentativa)).toEqual([2, 3]);
  });
});

describe("4. o timeout da main continua igual", () => {
  it("f) 10 s por tentativa, três tentativas; o retry de transporte também conta", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const sinal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        sinal?.addEventListener("abort", () =>
          reject(sinal.reason ?? new DOMException("abortada", "AbortError")),
        );
      });
    });

    const pedido = apiClient.get("/api/v1/conversations?limit=50");
    const falha = expect(pedido).rejects.toMatchObject({ name: "TimeoutError" });

    // 3 x 10 s mais os backoffs — mesmo orçamento de parede da `main`.
    await vi.advanceTimersByTimeAsync(60_000);
    await falha;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(registros().map((l) => [l.tentativa, l.erro])).toEqual([
      [2, "tempo_esgotado"],
      [3, "tempo_esgotado"],
    ]);
  });
});
