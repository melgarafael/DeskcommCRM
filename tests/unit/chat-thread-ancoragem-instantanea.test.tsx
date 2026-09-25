import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/lib/types/messaging";

/**
 * A PRIMEIRA ANCORAGEM É INSTANTÂNEA; AS SEGUINTES, SUAVES (#1590, PR #1617).
 *
 * Ao abrir uma conversa, o fio ia ao fim com `behavior: "smooth"`: quem atende
 * via o histórico antigo passando e esperava a animação antes de ler a última
 * mensagem. A regra agora é `auto` na abertura de cada conversa — inclusive a
 * que abre VAZIA e recebe o conteúdo depois (o cartão de passagem chega após a
 * primeira pintura, ver o comentário do efeito em ChatThread.tsx) — e `smooth`
 * só para o que chega depois.
 *
 * Nenhum outro teste renderiza o ChatThread de verdade, então sem este nada
 * impediria a linha de voltar a `smooth` fixo.
 */

const estado = vi.hoisted(() => ({ mensagens: [] as unknown[] }));

vi.mock("@/hooks/inbox/useMessagesRealtime", () => ({
  useMessagesRealtime: () => ({
    data: { pages: [{ data: estado.mensagens }] },
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/inbox/useConversationNotes", () => ({ useConversationNotes: () => [] }));
vi.mock("@/hooks/inbox/usePassagensDaConversa", () => ({ usePassagensDaConversa: () => [] }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useDeleteNote", () => ({ useDeleteNote: () => ({ mutate: vi.fn() }) }));
vi.mock("@/hooks/ai/useDebugToggle", () => ({ useDebugToggle: () => ({ enabled: false }) }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ role: "agent" }),
  useUser: () => ({ id: "u-1" }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
vi.mock("@/components/inbox/MessageBubble", () => ({ MessageBubble: () => <div /> }));
vi.mock("@/components/inbox/NoteCard", () => ({ NoteCard: () => null }));
vi.mock("@/components/inbox/PassagemCard", () => ({ PassagemCard: () => null }));

import { ChatThread } from "@/components/inbox/ChatThread";

function mensagem(n: number): Message {
  return {
    id: `m-${n}`,
    sent_at: new Date(Date.UTC(2026, 8, 24, 12, n)).toISOString(),
    reply_to_message_id: null,
  } as unknown as Message;
}

// O ChatThread usa `useAlterarMensagem` (react-query) desde o #1626; o `wrapper`
// do RTL é mantido no `rerender`, e o cliente é um só por teste.
let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

const rolar = vi.fn();
const original = Element.prototype.scrollIntoView;

/** O `behavior` de cada chamada, em ordem. */
function comportamentos(): unknown[] {
  return rolar.mock.calls.map((c) => (c[0] as ScrollIntoViewOptions).behavior);
}

describe("ChatThread: ancoragem ao fim", () => {
  beforeEach(() => {
    qc = new QueryClient();
    rolar.mockClear();
    estado.mensagens = [];
    Element.prototype.scrollIntoView = rolar;
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  it("abre a conversa com histórico indo ao fim SEM animação", () => {
    estado.mensagens = [mensagem(1), mensagem(2)];
    render(<ChatThread conversationId="c-1" />, { wrapper });
    expect(rolar).toHaveBeenCalledWith({ behavior: "auto", block: "end" });
    expect(comportamentos()).not.toContain("smooth");
  });

  it("mensagem nova, depois da abertura, rola suave", () => {
    estado.mensagens = [mensagem(1)];
    const { rerender } = render(<ChatThread conversationId="c-1" />, { wrapper });
    rolar.mockClear();
    estado.mensagens = [mensagem(1), mensagem(2)];
    rerender(<ChatThread conversationId="c-1" />);
    expect(comportamentos()).toEqual(["smooth"]);
  });

  it("conversa que abre vazia: o primeiro conteúdo que chega ainda é a abertura (auto)", () => {
    const { rerender } = render(<ChatThread conversationId="c-1" />, { wrapper });
    estado.mensagens = [mensagem(1)];
    rerender(<ChatThread conversationId="c-1" />);
    expect(comportamentos()).toEqual(["auto"]);
  });

  it("trocar de conversa volta a abrir instantâneo", () => {
    estado.mensagens = [mensagem(1)];
    const { rerender } = render(<ChatThread conversationId="c-1" />, { wrapper });
    rolar.mockClear();
    rerender(<ChatThread conversationId="c-2" />);
    expect(comportamentos()).toEqual(["auto"]);
  });
});
