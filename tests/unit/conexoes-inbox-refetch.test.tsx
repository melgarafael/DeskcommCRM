import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A LISTA DO INBOX NÃO VOLTA AO SKELETON NUM REFETCH (#2366).
 *
 * ─── O defeito, medido ───────────────────────────────────────────────────────
 * No trace do #2360 (run 37340942770) a lista busca `comando=aguardando`,
 * recebe 200 — e quando `/ai/automatico-ativo` responde, `comandosDaFila`
 * troca a chave para `aguardando,automatico`. O react-query abre uma query
 * NOVA sem dado, `isLoading` volta a ser verdadeiro, a primeira resposta é
 * DESCARTADA e a tela cai no skeleton (`ConversationList.tsx`) enquanto um
 * segundo GET sai ~2 s depois. Custo: 1 a 3 s de tela vazia a cada carga do
 * inbox.
 *
 * Os três casos do critério, e por que cada um é um teste:
 *   1. primeira carga → skeleton (CONTROLE: sem ele, "não piscar" seria
 *      trivialmente verde);
 *   2. a chave muda com dado na tela → a lista anterior segue lá, sem
 *      skeleton, e a resposta nova entra por cima (é este que reprova sem o
 *      `placeholderData` do hook);
 *   3. refetch que FALHA com dado na tela → a lista é preservada, o erro não
 *      a substitui (reprova sem a guarda do `isError` no componente).
 *
 * O hook e o componente são os REAIS: só os vizinhos (realtime, toast, linhas
 * da lista) são dublês — o defeito mora justamente no encontro dos dois.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
}));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({ useAutomaticoAtivo: () => ({ data: true }) }));
vi.mock("@/components/inbox/ConversationListItem", () => ({
  ConversationListItem: ({ conversation }: { conversation: { id: string } }) => (
    <div data-testid="linha">{conversation.id}</div>
  ),
}));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: () => ({ status: "subscribed", ultimaEntrega: { current: null } }),
}));
vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({
  useRefetchDeSeguranca: () => ({
    divergencias: 0,
    ultimaDivergencia: null,
    ultimaVerificacao: null,
  }),
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

/**
 * CADA GET FICA EM BOLSA na fila — o teste decide quando a resposta chega, e é
 * isso que permite afirmar "a lista antiga está na tela ENQUANTO a nova busca
 * voa", que é o estado em que o defeito aparece.
 */
const chamadas = vi.hoisted(
  () =>
    [] as {
      url: string;
      resolver: (resposta: unknown) => void;
      recusar: (erro: unknown) => void;
    }[],
);
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (url: string) =>
      new Promise((resolver, recusar) => {
        chamadas.push({ url, resolver, recusar });
      }),
  },
}));

const { ConversationList } = await import("@/components/inbox/ConversationList");
const { useConversationsRealtime } = await import("@/hooks/inbox/useConversationsRealtime");
type ConversationsFilters = import("@/hooks/inbox/useConversationsRealtime").ConversationsFilters;

/** Uma linha de resposta — só o que a lista lê. */
function pagina(ids: string[]) {
  return {
    data: ids.map((id) => ({ id })),
    meta: { has_more: false, cursor: null },
  };
}

// O Skeleton deixou a classe `animate-pulse` no #2411: a âncora é `data-esqueleto`, como em inbox-media-image.
function esqueleto(): number {
  return document.querySelectorAll("[data-esqueleto]").length;
}

/** A tela real: hook real alimentando o componente real, mais o estado exposto. */
function Tela({ filtros }: { filtros: ConversationsFilters }) {
  const q = useConversationsRealtime(filtros, "org-1");
  return (
    <>
      <ConversationList
        listQuery={q}
        filters={filtros}
        selectedId={null}
        onSelect={() => undefined}
      />
      <div
        data-testid="estado"
        data-carregando={q.isLoading}
        data-buscando={q.isFetching}
        data-erro={q.isError}
      />
      <button onClick={() => void q.refetch()}>recarregar</button>
    </>
  );
}

function montar(filtros: ConversationsFilters) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const arvore = (f: ConversationsFilters) => (
    <QueryClientProvider client={qc}>
      <Tela filtros={f} />
    </QueryClientProvider>
  );
  const utils = render(arvore(filtros));
  return { qc, ...utils, pintar: (f: ConversationsFilters) => utils.rerender(arvore(f)) };
}

/** A busca na fila — e ela DIZ qual posição faltou, em vez de virar `undefined`. */
function busca(indice: number) {
  const chamada = chamadas[indice];
  if (!chamada) {
    throw new Error(`nenhum GET na posição ${indice} — a fila tem ${chamadas.length}`);
  }
  return chamada;
}

async function entregar(indice: number, ids: string[]) {
  const chamada = busca(indice);
  await act(async () => {
    chamada.resolver(pagina(ids));
  });
}

async function falhar(indice: number) {
  const chamada = busca(indice);
  await act(async () => {
    chamada.recusar(new Error("rede fora"));
  });
}

function estado() {
  return screen.getByTestId("estado").dataset;
}

beforeEach(() => {
  chamadas.length = 0;
});
afterEach(() => cleanup());

describe("a lista do inbox não volta ao skeleton num refetch (#2366)", () => {
  it("primeira carga: MOSTRA o skeleton — é o único momento em que ele diz algo", async () => {
    montar({ comando: ["aguardando"] });
    await waitFor(() => expect(chamadas).toHaveLength(1));

    expect(estado().carregando).toBe("true");
    expect(esqueleto()).toBeGreaterThan(0);
    expect(screen.queryByTestId("linha")).not.toBeInTheDocument();
  });

  it("⭐ a troca de chave (automatico-ativo responde) mantém a lista anterior na tela", async () => {
    const { pintar } = montar({ comando: ["aguardando"] });
    await entregar(0, ["c1", "c2"]);
    await waitFor(() => expect(screen.getByText("c1")).toBeInTheDocument());
    expect(esqueleto()).toBe(0);

    // A resposta do automatico-ativo muda a chave: um SEGUNDO GET sai e fica
    // em voo. Enquanto ele não volta, a lista tem de continuar na tela.
    pintar({ comando: ["aguardando", "automatico"] });
    await waitFor(() => expect(chamadas).toHaveLength(2));

    expect(screen.getByText("c1")).toBeInTheDocument();
    expect(screen.getByText("c2")).toBeInTheDocument();
    expect(esqueleto(), "a lista não pode cair no skeleton enquanto a chave nova responde").toBe(0);
    expect(estado().buscando).toBe("true");

    // E a resposta da chave nova entra por cima, ainda sem passar pelo skeleton.
    await entregar(1, ["c1", "c2", "c3"]);
    await waitFor(() => expect(screen.getByText("c3")).toBeInTheDocument());
    expect(screen.getByText("c1")).toBeInTheDocument();
    expect(esqueleto()).toBe(0);
  });

  it("refetch em voo na MESMA chave: a lista anterior fica visível até a resposta chegar", async () => {
    const { qc } = montar({ comando: ["aguardando"] });
    await entregar(0, ["c1"]);
    await waitFor(() => expect(screen.getByText("c1")).toBeInTheDocument());

    await act(async () => {
      void qc.refetchQueries({ queryKey: ["conversations"] });
    });
    await waitFor(() => expect(chamadas).toHaveLength(2));

    expect(screen.getByText("c1")).toBeInTheDocument();
    expect(esqueleto()).toBe(0);

    await entregar(1, ["c1", "c2"]);
    await waitFor(() => expect(screen.getByText("c2")).toBeInTheDocument());
    expect(esqueleto()).toBe(0);
  });

  it("⭐ refetch que FALHA com dado na tela: a lista é preservada, o erro não a substitui", async () => {
    montar({ comando: ["aguardando"] });
    await entregar(0, ["c1", "c2"]);
    await waitFor(() => expect(screen.getByText("c1")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "recarregar" }));
    await waitFor(() => expect(chamadas).toHaveLength(2));
    await falhar(1);

    // A prova de que o refetch MESMO falhou — sem isto o teste passaria antes
    // de a falha chegar e não estaria testando nada.
    await waitFor(() => expect(estado().erro).toBe("true"));

    expect(screen.getByText("c1")).toBeInTheDocument();
    expect(screen.getByText("c2")).toBeInTheDocument();
    expect(screen.queryByText(/Erro ao carregar conversas/)).not.toBeInTheDocument();
    expect(esqueleto()).toBe(0);
  });

  it("refetch sem nada de novo: a tela não muda — nem skeleton, nem lista vazia", async () => {
    const { qc } = montar({ comando: ["aguardando"] });
    await entregar(0, ["c1", "c2"]);
    await waitFor(() => expect(screen.getByText("c1")).toBeInTheDocument());

    await act(async () => {
      void qc.refetchQueries({ queryKey: ["conversations"] });
    });
    await waitFor(() => expect(chamadas).toHaveLength(2));
    // O realtime pediu a recarga e o servidor não tinha nada novo.
    await entregar(1, ["c1", "c2"]);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("c1")).toBeInTheDocument();
    expect(screen.getByText("c2")).toBeInTheDocument();
    expect(screen.queryByText(/Sem conversas por aqui/)).not.toBeInTheDocument();
    expect(esqueleto()).toBe(0);
    expect(estado().carregando).toBe("false");
  });
});

/**
 * O OUTRO LADO DO MESMO CONSERTO: a lista anterior só fica na tela quando a
 * troca de chave é o `automatico-ativo` respondendo. Trocar de aba ou de busca
 * é pedir OUTRA lista — mostrar a anterior enquanto a nova carrega põe na tela
 * linhas que não são da aba, clicáveis e (na Fila) numeradas como se fossem.
 * Os dois casos reprovam com `placeholderData: keepPreviousData` puro.
 */
describe("troca de aba ou de busca NÃO reaproveita a lista anterior (#2366)", () => {
  it("Todas → Fila: enquanto a Fila carrega, volta o skeleton e as linhas de Todas saem", async () => {
    const { pintar } = montar({});
    await entregar(0, ["todas-1", "todas-2"]);
    await waitFor(() => expect(screen.getByText("todas-1")).toBeInTheDocument());

    pintar({ comando: ["aguardando"] });
    await waitFor(() => expect(chamadas).toHaveLength(2));

    expect(screen.queryByText("todas-1"), "linha da aba anterior na aba nova").not.toBeInTheDocument();
    expect(esqueleto()).toBeGreaterThan(0);

    await entregar(1, ["fila-1"]);
    await waitFor(() => expect(screen.getByText("fila-1")).toBeInTheDocument());
    expect(screen.queryByText("todas-1")).not.toBeInTheDocument();
  });

  it("busca nova DENTRO da Fila: o resultado da busca anterior não fica na tela", async () => {
    // Os dois lados são a Fila e o `comando` é o mesmo: só a busca mudou. É o
    // caso que separa "é a Fila" de "só o automático mudou".
    const { pintar } = montar({ comando: ["aguardando"], search: "maria" });
    await entregar(0, ["maria-1"]);
    await waitFor(() => expect(screen.getByText("maria-1")).toBeInTheDocument());

    pintar({ comando: ["aguardando"], search: "joao" });
    await waitFor(() => expect(chamadas).toHaveLength(2));

    expect(screen.queryByText("maria-1"), "resultado da busca anterior").not.toBeInTheDocument();
    expect(esqueleto()).toBeGreaterThan(0);
  });
});
