import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O INBOX NÃO CONFUNDE "NÃO CONSEGUI LER" COM "NÃO HÁ CONVERSAS" (#4508).
 *
 * ─── O que a sonda mediu na `origin/main`, antes deste conserto ──────────────
 *
 * Com o hook REAL (`useConversationsRealtime`) e a tela REAL
 * (`ConversationList`), numa rota que nunca responde:
 *
 *   - 30.714 ms até a tela dizer qualquer coisa, 30.559 ms deles de esqueleto
 *     (três tentativas de 10 s mais o backoff do cliente);
 *   - 3 chamadas ao `fetch`, e nenhuma linha na tela no fim;
 *   - o alerta dizia "A consulta das conversas excedeu o tempo limite" — isso
 *     o #4512 já tinha consertado.
 *
 * Mas com a LISTA JÁ CARREGADA e o refetch falhando:
 *
 *   - as linhas continuavam na tela (certo);
 *   - `aviso_de_desatualizado: null` — a tela NÃO dizia nada. O único sinal era
 *     um toast que some em 5 s, e quem atende ficava olhando uma lista que
 *     podia estar de minutos atrás sem saber;
 *   - e 41 conferências em 30 min contra um servidor que só devolve erro
 *     (1,33/min), porque o refetch de segurança tinha intervalo fixo de 45 s.
 *
 * ─── O que este arquivo trava ───────────────────────────────────────────────
 *
 *   1. falha de leitura com lista na tela: a lista FICA e aparece um aviso
 *      persistente, distinguível do "Sem conversas por aqui";
 *   2. lista carregada que veio VAZIA e depois falha: erro, não "sem
 *      conversas" — vazio de verdade é o caso em que a leitura respondeu;
 *   3. com a API fora, o hook não repete para sempre: a espera cresce;
 *   4. o sucesso depois da falha recoloca a lista e tira o aviso, sem recarregar
 *      a página.
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

function montar(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <Inbox />
    </QueryClientProvider>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("1. erro de leitura com lista na tela: a lista fica e a tela avisa", () => {
  it("a) o refetch que falha não apaga as conversas e mostra aviso distinguível do vazio", async () => {
    let caiu = false;
    fetchMock.mockImplementation(async () => {
      if (caiu) throw new TypeError("Failed to fetch");
      return listaDe(["conv-1", "conv-2"]);
    });

    const qc = novoCliente();
    montar(qc);
    await waitFor(() => expect(screen.getAllByTestId("linha")).toHaveLength(2));

    caiu = true;
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["conversations"] });
    });
    // O observador do react-query publica a falha um tique depois de
    // `refetchQueries` resolver — o `waitFor` espera a tela, não o relógio.
    await waitFor(() => expect(screen.getByTestId("lista-desatualizada")).toBeInTheDocument());

    // A lista que já estava na tela continua onde está.
    expect(screen.getAllByTestId("linha").map((l) => l.textContent)).toEqual([
      "conv-1",
      "conv-2",
    ]);

    // E a tela DIZ que está desatualizada, com o motivo — não um toast que some.
    const aviso = screen.getByTestId("lista-desatualizada");
    expect(aviso).toHaveTextContent("Não foi possível falar com o servidor. Verifique a conexão.");
    expect(aviso).toHaveTextContent(
      "Mostrando as conversas que já estavam na tela. Nada foi perdido.",
    );
    expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeInTheDocument();

    // Distinguível do vazio: a caixa NÃO diz "sem conversas" quando o que houve
    // foi falha de leitura, e o aviso não se anuncia como erro da tela inteira.
    expect(screen.queryByText(/Sem conversas por aqui/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("b) lista que já tinha vindo vazia e depois falha mostra o ERRO, não o vazio", async () => {
    let caiu = false;
    fetchMock.mockImplementation(async () => {
      if (caiu) throw new TypeError("Failed to fetch");
      return listaDe([]);
    });

    const qc = novoCliente();
    montar(qc);
    // Vazio de VERDADE: a leitura respondeu, e não há conversa nenhuma.
    await waitFor(() => expect(screen.getByText(/Sem conversas por aqui/i)).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    caiu = true;
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["conversations"] });
    });
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    // A MESMA tela, agora sem resposta: o que se sabe é que a leitura falhou.
    // Afirmar "sem conversas" aqui é dizer que a caixa está vazia quando o
    // banco pode estar cheio — a leitura de "perdi os dados" que a issue relata.
    const alerta = screen.getByRole("alert");
    expect(alerta).toHaveTextContent(
      "Não foi possível falar com o servidor. Verifique a conexão.",
    );
    expect(screen.queryByText(/Sem conversas por aqui/i)).not.toBeInTheDocument();
  });

  it("b) resposta vazia de verdade mostra o estado vazio, e não erro", async () => {
    fetchMock.mockResolvedValue(listaDe([]));
    montar(novoCliente());

    await waitFor(() => expect(screen.getByText(/Sem conversas por aqui/i)).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByTestId("lista-desatualizada")).not.toBeInTheDocument();
  });
});

describe("2. com a API fora, o hook não repete para sempre", () => {
  it("c) 30 min de aba aberta não viram 30 min de requisição: a espera cresce", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    fetchMock.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });

    const qc = novoCliente();
    montar(qc);

    // A primeira carga: uma requisição do cliente HTTP (que repete três vezes
    // por conta própria — por isso 3 `fetch`, e isso não muda aqui).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const naPrimeiraCarga = fetchMock.mock.calls.length;

    for (let minuto = 0; minuto < 30; minuto++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
    }

    const total = fetchMock.mock.calls.length;
    const conferencias = (total - naPrimeiraCarga) / 3;

    // ANTES: intervalo fixo de 45 s → 40 conferências em 30 min (1,33/min),
    // cada uma com as três tentativas do cliente. Medido na sonda.
    // DEPOIS: 45 s, 90 s, 180 s, 360 s, 600 s (teto) → 5 conferências.
    expect(conferencias, `conferências em 30 min: ${conferencias}`).toBeLessThanOrEqual(8);
    expect(conferencias, "esperava ao menos uma conferência de recuperação").toBeGreaterThanOrEqual(
      4,
    );
    expect(total).toBeLessThanOrEqual(3 * 8 + naPrimeiraCarga);
  });
});

describe("3. o sucesso depois da falha recoloca a lista", () => {
  it("d) clicar em 'Tentar novamente' no aviso traz a lista nova e tira o aviso", async () => {
    let modo: "ok" | "caiu" | "voltou" = "ok";
    fetchMock.mockImplementation(async () => {
      if (modo === "caiu") throw new TypeError("Failed to fetch");
      if (modo === "voltou") return listaDe(["conv-3"]);
      return listaDe(["conv-1"]);
    });

    const qc = novoCliente();
    montar(qc);
    await waitFor(() => expect(screen.getByTestId("linha")).toHaveTextContent("conv-1"));

    modo = "caiu";
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["conversations"] });
    });
    await waitFor(() =>
      expect(screen.getByTestId("lista-desatualizada")).toBeInTheDocument(),
    );

    modo = "voltou";
    await act(async () => {
      screen.getByRole("button", { name: "Tentar novamente" }).click();
    });

    await waitFor(() =>
      expect(screen.getAllByTestId("linha").map((l) => l.textContent)).toEqual(["conv-3"]),
    );
    expect(screen.queryByTestId("lista-desatualizada")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
