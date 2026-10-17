/**
 * "USAR COMO EXEMPLO PARA A IA" — O BOTÃO QUE NÃO EXISTIA (#3006).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * A rota `POST /api/v1/conversations/{id}/usable-for-rag` entrou com o opt-in de
 * LGPD (L-08) e ficou SEM TELA: `git grep usable-for-rag` sobre `components/` e
 * `app/app/` não devolvia chamador nenhum. Só quem usava a API conseguia dizer
 * ao agente de qual atendimento ele deveria aprender — e o dono da operação, que
 * é quem sabe quais atendimentos foram exemplares, não usa API.
 *
 * ─── O que estes testes prendem ─────────────────────────────────────────────
 *
 *  1. O CLIQUE SAI PARA A ROTA, com o corpo que ela espera — `{ enabled: true }`
 *     para marcar, `{ enabled: false }` para desmarcar. É a asserção que a
 *     sabotagem tem de derrubar: sem o `onClick` ligado, os dois casos ficam
 *     vermelhos.
 *  2. O SELO da conversa marcada: aparece marcada, NÃO aparece desmarcada.
 *  3. A linha SEM a prop de exemplo é a linha de antes — nenhum controle novo é
 *     montado. É o que protege os outros arquivos que renderizam a linha sozinha
 *     e o que mantém a promessa de "acréscimo, não reforma".
 *
 * A navegação real (lista → linha → rota) é montada aqui com o `ConversationList`
 * de verdade: mockar a linha deixaria de fora justamente o fio que estava
 * faltando.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";
import { conversaDeExemplo } from "@/components/inbox/__fixtures__/conversa";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import type { ConversationsFilters } from "@/hooks/inbox/useConversationsRealtime";

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ data: { id: "conv-1", usable_for_rag: true } }),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
// O dicionário de verdade exigiria um `IdiomaProvider`; o texto não é o que este
// arquivo mede (quem o mede é `i18n-espanhol-cobre-a-tela`).
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
}));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({
  useAutomaticoAtivo: () => ({ data: false }),
}));

const { ConversationList } = await import("@/components/inbox/ConversationList");
const { ConversationListItem } = await import("@/components/inbox/ConversationListItem");

const ROTA = `/api/v1/conversations/${conversaDeExemplo.conversation.id}/usable-for-rag`;

const ROTULO_MARCAR = "Usar como exemplo para a IA";
const ROTULO_DESMARCAR = "Deixar de usar como exemplo";

function comExemplo(usable: boolean): ConversationWithContact {
  return { ...conversaDeExemplo.conversation, usable_for_rag: usable };
}

/** A linha sozinha, com a ação ligada — como a lista a monta. */
function montarLinha(conversation: ConversationWithContact) {
  return render(
    <ConversationListItem
      {...conversaDeExemplo.props}
      conversation={conversation}
      onAlternarExemplo={() => undefined}
    />,
  );
}

/**
 * A lista REAL: o `ConversationList` de verdade, com a linha de verdade dentro e
 * a mutação de verdade. É o caminho que produção percorre — é ele que precisa
 * chegar na rota.
 */
function montarLista(conversation: ConversationWithContact, podeMarcarExemplo = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const listQuery = {
    data: { pages: [{ data: [conversation], meta: { has_more: false } }] },
    isPending: false,
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  } as never;
  return render(
    <QueryClientProvider client={client}>
      <ConversationList
        listQuery={listQuery}
        filters={{} as ConversationsFilters}
        selectedId={null}
        onSelect={() => undefined}
        podeMarcarExemplo={podeMarcarExemplo}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("o clique chega na rota usable-for-rag (#3006)", () => {
  it("marcar envia POST .../usable-for-rag com enabled true", async () => {
    const user = userEvent.setup();
    montarLista(comExemplo(false));

    await user.click(screen.getByRole("button", { name: ROTULO_MARCAR }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    expect(apiClient.post).toHaveBeenCalledWith(ROTA, { enabled: true });
  });

  it("desmarcar envia POST .../usable-for-rag com enabled false", async () => {
    const user = userEvent.setup();
    montarLista(comExemplo(true));

    await user.click(screen.getByRole("button", { name: ROTULO_DESMARCAR }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    expect(apiClient.post).toHaveBeenCalledWith(ROTA, { enabled: false });
  });

  it("CONTROLE: sem clique, nenhuma chamada sai — o botão não dispara sozinho", async () => {
    montarLista(comExemplo(false));
    expect(screen.getByRole("button", { name: ROTULO_MARCAR })).toBeInTheDocument();
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

describe("o selo da conversa marcada (#3006)", () => {
  it("marcada mostra o selo", () => {
    montarLinha(comExemplo(true));
    const selo = screen.getByTestId("selo-exemplo-ia");
    expect(selo).toHaveTextContent("Exemplo para a IA");
  });

  it("não marcada não mostra selo nenhum", () => {
    montarLinha(comExemplo(false));
    expect(screen.queryByTestId("selo-exemplo-ia")).toBeNull();
  });

  it("o controle diz o que vai acontecer: marcar quando está fora, desmarcar quando está dentro", () => {
    const { unmount } = montarLinha(comExemplo(false));
    expect(screen.getByRole("button", { name: ROTULO_MARCAR })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    unmount();

    montarLinha(comExemplo(true));
    expect(screen.getByRole("button", { name: ROTULO_DESMARCAR })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("a linha sem a ação continua sendo a linha de antes (#3006)", () => {
  it("sem `onAlternarExemplo` não há controle nem selo", () => {
    render(
      <ConversationListItem
        {...conversaDeExemplo.props}
        conversation={comExemplo(true)}
      />,
    );
    expect(screen.queryByTestId(`exemplo-ia-${conversaDeExemplo.conversation.id}`)).toBeNull();
    expect(screen.queryByRole("button", { name: ROTULO_DESMARCAR })).toBeNull();
  });
});

describe("quem só lê vê o selo e não o controle (#3006)", () => {
  it("sem `podeMarcarExemplo` a lista não monta o botão, e o selo continua", () => {
    montarLista(comExemplo(true), false);
    expect(screen.queryByTestId(`exemplo-ia-${conversaDeExemplo.conversation.id}`)).toBeNull();
    expect(screen.getByTestId("selo-exemplo-ia")).toHaveTextContent("Exemplo para a IA");
  });
});
