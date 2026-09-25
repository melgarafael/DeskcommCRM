import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O DEEP-LINK NÃO ESPERA A LISTA DE CONVERSAS.
 *
 * ## O defeito, medido no CI (run 34226618108, `e2e-parte (3)`)
 *
 * `encerramento-atendimento` abre `/app/inbox/<id>` de uma conversa **fechada**
 * e espera a Memória do contato. Conversa fechada não aparece em nenhuma aba da
 * Fila, então a busca única por id é a ÚNICA fonte do objeto — e ela só saía
 * depois de a lista assentar DUAS vezes (a `queryKey` muda quando
 * `useAutomaticoAtivo` responde, e `isLoading` volta a ser verdadeiro na chave
 * nova). O waterfall do trace, em série:
 *
 *   conversations?comando=aguardando            1091ms
 *   conversations?comando=aguardando,automatico  896ms
 *   conversations/<id>                           565ms
 *   contacts/<id>/crm-summary                 (>1034ms)
 *
 * O painel do contato começava a carregar ~4,7s depois da navegação. A tela
 * mostrava a coisa certa — o screenshot de falha já traz "Histórico encerrado" —
 * só que ~0,1–0,6s depois do prazo da asserção. Vermelho por latência, e a
 * latência era estrutural, não do teste.
 *
 * ## Por que este teste e não uma leitura do fonte
 *
 * O que precisa continuar valendo é COMPORTAMENTO: com a lista ainda no ar, a
 * conversa do deep-link já tem objeto e o painel do contato já pode carregar.
 * Um teste que procurasse `!listQ.isLoading` no arquivo aprovaria qualquer outra
 * forma de reintroduzir a espera (um `enabled` novo, um `useEffect` que segura).
 * Aqui a lista NUNCA responde: se a busca única voltar a depender dela, o
 * painel fica sem conversa e o caso reprova.
 */

const { ORG, CONVERSA, OUTRA_CONVERSA, CONVERSA_ROW } = vi.hoisted(() => {
  const ORG = "00000000-0000-4000-8000-0000000000aa";
  const CONVERSA = "00000000-0000-4000-8000-0000000000cc";
  const OUTRA_CONVERSA = "00000000-0000-4000-8000-0000000000dd";
  const CONTATO = "00000000-0000-4000-8000-0000000000c1";
  return {
    ORG,
    CONVERSA,
    OUTRA_CONVERSA,
    CONTATO,
    CONVERSA_ROW: {
      id: CONVERSA,
      organization_id: ORG,
      contact_id: CONTATO,
      // Fechada: e o caso do CI — nenhuma aba da Fila a devolve, entao a lista
      // jamais traria este objeto, por mais que se esperasse por ela.
      status: "closed",
      tags: [],
      contacts: {
        id: CONTATO,
        display_name: "Cliente Encerramento",
        name: null,
        phone_number: "+5511999887666",
        tags: [],
      },
    },
  };
});

const get = vi.fn(async (bruta?: string): Promise<unknown> => {
  // `?? ""` porque sob concorrência de CPU um hook fora do escopo deste teste
  // chegou a chamar o cliente já desmontado, sem URL. Coagir é melhor que
  // estourar: o caso mede QUEM foi pedido, e uma chamada sem URL não é pedido.
  const url = bruta ?? "";
  if (url.startsWith("/api/v1/conversations?")) {
    // A lista NUNCA responde, de propósito: era ela que o gate esperava.
    return new Promise(() => {});
  }
  if (url === `/api/v1/conversations/${CONVERSA}`) {
    return { data: CONVERSA_ROW };
  }
  if (url === `/api/v1/conversations/${OUTRA_CONVERSA}`) {
    return { data: { ...CONVERSA_ROW, id: OUTRA_CONVERSA } };
  }
  if (url === "/api/v1/ai/automatico-ativo") return { data: { ativo: false } };
  if (url === "/api/v1/conversations/counts") return { data: {} };
  if (url === "/api/v1/conversation-tags") return { data: [] };
  return { data: [] };
});

vi.mock("@/lib/api/client", () => ({ apiClient: { get: (url: string) => get(url) } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/lib/supabase/browser", () => ({
  prepareRealtimeAuthentication: vi.fn().mockResolvedValue(undefined),
  createClient: () => ({
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inbox",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "u-1", role: "admin" }, activeOrg: { orgId: ORG } }),
  usePermission: () => true,
}));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({ useMarkAsRead: () => undefined }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

/** O painel do contato vira sonda: ele diz de QUAL conversa recebeu objeto. */
vi.mock("@/components/inbox/CRMSidePanel", () => ({
  CRMSidePanel: ({ conversation }: { conversation: { id: string } | null }) => (
    <div data-testid="painel">{conversation ? conversation.id : "sem-conversa"}</div>
  ),
}));
vi.mock("@/components/inbox/ConversationList", () => ({
  ConversationList: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <>
      <button onClick={() => onSelect(CONVERSA)}>Abrir cliente</button>
      <button onClick={() => onSelect(OUTRA_CONVERSA)}>Abrir outro cliente</button>
    </>
  ),
}));
vi.mock("@/components/inbox/InboxFilters", () => ({ InboxFilters: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/components/inbox/Composer", () => ({ Composer: () => null }));
vi.mock("@/components/inbox/ConversationHeader", () => ({ ConversationHeader: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/InboxKeyboardShortcuts", () => ({
  InboxKeyboardShortcuts: () => null,
}));
vi.mock("@/components/inbox/ShortcutsHelpDialog", () => ({ ShortcutsHelpDialog: () => null }));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({ JanelaFechadaAviso: () => null }));

import { InboxLayout } from "@/components/inbox/InboxLayout";

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InboxLayout initialSelectedId={CONVERSA} />
    </QueryClientProvider>,
  );
}

describe("deep-link para conversa fora do filtro", () => {
  beforeEach(() => {
    get.mockClear();
    window.history.replaceState(null, "", "/app/inbox");
  });

  it("pede a conversa por id SEM esperar a lista responder", async () => {
    montar();
    await waitFor(() =>
      expect(get.mock.calls.map((c) => c[0])).toContain(`/api/v1/conversations/${CONVERSA}`),
    );
    // O controle: a lista continua no ar. Sem ele, este caso passaria também
    // num mundo em que a busca única espera — bastaria a lista ter respondido.
    expect(
      get.mock.calls.some((c) => (c[0] ?? "").startsWith("/api/v1/conversations?")),
    ).toBe(true);
  });

  it("entrega a conversa ao painel do contato com a lista ainda no ar", async () => {
    montar();
    await waitFor(() => expect(screen.getByTestId("painel")).toHaveTextContent(CONVERSA));
  });

  it("gera link por conversa e acompanha a volta do navegador", async () => {
    window.history.replaceState(null, "", "/app/inbox?filter=all");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tela = render(
      <QueryClientProvider client={qc}>
        <InboxLayout />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Abrir cliente" }));
    expect(window.location.pathname + window.location.search).toBe(
      `/app/inbox?filter=all&id=${CONVERSA}`,
    );
    await waitFor(() => expect(screen.getByTestId("painel")).toHaveTextContent(CONVERSA));

    fireEvent.click(screen.getByRole("button", { name: "Abrir outro cliente" }));
    expect(window.location.pathname + window.location.search).toBe(
      `/app/inbox?filter=all&id=${OUTRA_CONVERSA}`,
    );
    await waitFor(() => expect(screen.getByTestId("painel")).toHaveTextContent(OUTRA_CONVERSA));

    // Simula as duas entradas anteriores que o botão Voltar restaura.
    window.history.replaceState(null, "", `/app/inbox?filter=all&id=${CONVERSA}`);
    tela.rerender(
      <QueryClientProvider client={qc}>
        <InboxLayout />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("painel")).toHaveTextContent(CONVERSA));

    window.history.replaceState(null, "", "/app/inbox?filter=all");
    tela.rerender(
      <QueryClientProvider client={qc}>
        <InboxLayout />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("painel")).toHaveTextContent("sem-conversa"));
  });
});
