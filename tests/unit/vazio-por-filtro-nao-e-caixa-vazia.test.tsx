import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

import { filtrosAuxiliaresAtivos } from "@/lib/inbox/filtros-ativos";
import type { ConversationsFilters } from "@/hooks/inbox/useConversationsRealtime";

/**
 * LISTA VAZIA POR FILTRO NÃO É CAIXA VAZIA.
 *
 * ─── O defeito, medido na tela de uma instalação real ────────────────────────
 * Com duas conversas EXISTINDO e "Não lidos" ligado, a tela dizia:
 *
 *     "Sem conversas por aqui — quando chegarem mensagens, elas aparecem aqui"
 *
 * Verdade quando a caixa está vazia; mentira quando um filtro escondeu tudo. E o
 * `return` do vazio vinha ANTES do bloco do "Carregar mais", então o operador
 * ficava sem como alcançar a página seguinte: um beco sem saída.
 *
 * Os dois casos que importam são o do texto e o do botão — e eles quebram por
 * motivos diferentes, então são testes diferentes.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
}));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({
  useAutomaticoAtivo: () => ({ data: false }),
}));
vi.mock("@/components/inbox/ConversationListItem", () => ({
  ConversationListItem: () => null,
}));

const { ConversationList } = await import("@/components/inbox/ConversationList");

function listaFalsa({ itens = [], hasNextPage = false }: { itens?: unknown[]; hasNextPage?: boolean }) {
  return {
    data: { pages: [{ data: itens, meta: { has_more: hasNextPage } }] },
    isLoading: false,
    isError: false,
    hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  } as never;
}

function montar(filters: ConversationsFilters, hasNextPage = false) {
  return render(
    <ConversationList
      listQuery={listaFalsa({ itens: [], hasNextPage })}
      filters={filters}
      selectedId={null}
      onSelect={() => undefined}
    />,
  );
}

afterEach(() => cleanup());

describe("quais filtros a tela nomeia", () => {
  it("a ABA não entra — ela é onde o operador está, não algo a limpar", () => {
    expect(filtrosAuxiliaresAtivos({ comando: ["aguardando"] } as ConversationsFilters)).toEqual([]);
    expect(filtrosAuxiliaresAtivos({ exclude_finished: true } as ConversationsFilters)).toEqual([]);
  });

  it("os quatro auxiliares entram, e só quando ligados", () => {
    expect(filtrosAuxiliaresAtivos({} as ConversationsFilters)).toEqual([]);
    expect(filtrosAuxiliaresAtivos({ unread: true } as ConversationsFilters)).toEqual(["Não lidos"]);
    expect(
      filtrosAuxiliaresAtivos({ unread: true, tag: "urgente" } as ConversationsFilters),
    ).toEqual(["Não lidos", "Etiqueta"]);
  });
});

describe("o vazio por FILTRO não se disfarça de caixa vazia", () => {
  it("sem filtro e sem conversa: diz que a caixa está vazia", () => {
    montar({} as ConversationsFilters);
    expect(screen.getByText(/Sem conversas por aqui/i)).toBeInTheDocument();
  });

  it("COM filtro e sem resultado: NÃO diz que a caixa está vazia, e nomeia o filtro", () => {
    montar({ unread: true } as ConversationsFilters);
    expect(screen.queryByText(/Sem conversas por aqui/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Nenhuma conversa com esses filtros/i)).toBeInTheDocument();
    expect(screen.getByText(/Não lidos/i)).toBeInTheDocument();
  });

  it("⭐ COM filtro, sem resultado e com próxima página: o 'Carregar mais' CONTINUA lá", () => {
    // O defeito original em uma frase: o `return` do vazio vinha ANTES do bloco do
    // botão. Este é o caso que a sabotagem tem de derrubar.
    montar({ unread: true } as ConversationsFilters, true);
    expect(screen.getByRole("button", { name: /Carregar mais/i })).toBeInTheDocument();
  });

  it("CONTROLE: sem filtro e sem conversa, o 'Carregar mais' não é oferecido", () => {
    // Sem este caso, desenhar o botão SEMPRE passaria no de cima.
    montar({} as ConversationsFilters, false);
    expect(screen.queryByRole("button", { name: /Carregar mais/i })).not.toBeInTheDocument();
  });
});
