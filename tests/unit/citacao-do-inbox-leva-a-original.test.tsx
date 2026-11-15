import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/lib/types/messaging";

/**
 * CLICAR NA MENSAGEM CITADA LEVA ATÉ A ORIGINAL (#4575).
 *
 * O Inbox mostra, acima da resposta, o trecho da mensagem que o cliente (ou a
 * equipe) citou — a "resposta marcada" do WhatsApp. Até aqui o trecho era um
 * bloco morto: clicar nele não fazia nada, e quem atendia tinha de rolar a
 * conversa procurando a qual mensagem a pessoa respondeu.
 *
 * A lista do fio NÃO é virtualizada: é paginação por cursor (`useMessagesRealtime`,
 * 50 por página, `hasNextPage`/`fetchNextPage` para trás). Tudo o que está
 * carregado está no DOM, com `data-message-id`. Então o gesto tem dois caminhos,
 * e este arquivo mede os dois:
 *
 *   1. a original está na tela → rola até ela e acende o destaque;
 *   2. a original ficou em página antiga → pagina para trás e só então rola;
 *   3. a original não existe mais (linha apagada de verdade / fora do teto) →
 *      aviso curto, sem quebrar;
 *   4. a original foi APAGADA mas a linha ainda existe (`revoked_at`) → continua
 *      sendo alcançável: o fio existe, o texto é que não volta.
 *
 * A `MessageBubble` aqui é a REAL: o que se mede é o gesto que o atendente faz
 * (clicar no trecho) e o que o DOM mostra depois, não uma prop repassada.
 */

const estado = vi.hoisted(() => ({
  /** Páginas já carregadas, da mais nova para a mais antiga (como a rota devolve). */
  paginas: [] as { data: unknown[] }[],
  /** Páginas antigas que o `fetchNextPage` ainda pode trazer, uma a cada chamada. */
  proximas: [] as unknown[][],
  fetchNextPage: vi.fn(),
  forcarRender: null as null | (() => void),
}));

const aviso = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }));

vi.mock("sonner", () => ({ toast: aviso }));

vi.mock("@/hooks/inbox/useMessagesRealtime", async () => {
  const { useState } = await import("react");
  return {
    useMessagesRealtime: () => {
      const [, forcar] = useState(0);
      estado.forcarRender = () => forcar((n) => n + 1);
      return {
        data: { pages: estado.paginas },
        isLoading: false,
        isError: false,
        hasNextPage: estado.proximas.length > 0,
        isFetchingNextPage: false,
        fetchNextPage: async () => {
          estado.fetchNextPage();
          const antigas = estado.proximas.shift();
          if (antigas) estado.paginas = [...estado.paginas, { data: antigas }];
          // O commit da página nova acontece fora do clique: devolver o estado
          // novo e acordar a tela é o que o React Query faz de verdade.
          estado.forcarRender?.();
          return { hasNextPage: estado.proximas.length > 0 };
        },
        refetch: vi.fn(),
      };
    },
  };
});
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
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
vi.mock("@/components/inbox/NoteCard", () => ({ NoteCard: () => null }));
vi.mock("@/components/inbox/PassagemCard", () => ({ PassagemCard: () => null }));

import { ChatThread } from "@/components/inbox/ChatThread";

function msg(id: string, body: string, over: Partial<Message> = {}): Message {
  return {
    id,
    organization_id: "o1",
    conversation_id: "c-1",
    channel_session_id: "s1",
    contact_id: "ct1",
    external_id: null,
    type: "text",
    direction: "inbound",
    status: "delivered",
    ack: null,
    error_code: null,
    error_message: null,
    body,
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: null,
    sent_by_user_id: null,
    sent_at: "2026-09-24T12:00:00.000Z",
    delivered_at: null,
    read_at: null,
    metadata: null,
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: "2026-09-24T12:00:00.000Z",
    ...over,
  } as Message;
}

let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);
const rolar = vi.fn();
const original = Element.prototype.scrollIntoView;

/** O clique no trecho citado — o mesmo alvo em toda a tela (uma citação por teste). */
function clicarNaCitacao() {
  fireEvent.click(screen.getByRole("button", { name: "Ir para a mensagem citada" }));
}

/** Os elementos que receberam `scrollIntoView`, como atributo de identidade. */
function alvosDaRolagem(): (string | null)[] {
  return (rolar.mock.contexts as Element[]).map((el) => el.getAttribute("data-message-id"));
}

describe("Inbox: clicar na mensagem citada leva até a original", () => {
  beforeEach(() => {
    qc = new QueryClient();
    rolar.mockClear();
    aviso.info.mockClear();
    estado.fetchNextPage.mockClear();
    estado.paginas = [];
    estado.proximas = [];
    Element.prototype.scrollIntoView = rolar;
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  it("com a original carregada, rola até ela e acende o destaque", async () => {
    const citadaOriginal = msg("m-1", "O orçamento é o B, com frete incluso");
    estado.paginas = [
      {
        data: [
          citadaOriginal,
          // Resposta da EQUIPE (#4575 pede as duas direções).
          msg("m-2", "Fechado, vou emitir o B", {
            direction: "outbound",
            sent_via: "user",
            sent_by_user_id: "u-1",
            reply_to_message_id: "m-1",
            sent_at: "2026-09-24T12:05:00.000Z",
          }),
        ],
      },
    ];

    const { container } = render(<ChatThread conversationId="c-1" />, { wrapper });

    clicarNaCitacao();

    await waitFor(() => expect(alvosDaRolagem()).toContain("m-1"));
    // O alvo é a bolha da ORIGINAL, não a da resposta que citou.
    const alvo = container.querySelector('[data-message-id="m-1"]');
    expect(alvo).not.toBeNull();
    expect(rolar.mock.contexts).toContain(alvo);
    expect(alvo?.getAttribute("data-destacada")).toBe("true");
    // O outro balão não pisca: o destaque é do alvo, não da tela toda.
    expect(container.querySelector('[data-message-id="m-2"]')?.getAttribute("data-destacada")).toBeNull();
    // Nada foi buscado: a original já estava na tela.
    expect(estado.fetchNextPage).not.toHaveBeenCalled();
  });

  it("com a original fora da página, carrega o histórico até ela e rola", async () => {
    const antiga = msg("m-velha", "Segue a lista de documentos", {
      sent_at: "2026-09-20T12:00:00.000Z",
    });
    estado.paginas = [
      {
        data: [
          msg("m-nova", "Recebi, obrigado", {
            reply_to_message_id: "m-velha",
            sent_at: "2026-09-24T12:00:00.000Z",
          }),
        ],
      },
    ];
    estado.proximas = [[antiga]];

    const { container } = render(<ChatThread conversationId="c-1" />, { wrapper });

    // O fio continua desenhado mesmo sem a original carregada: sem ele não
    // haveria o que clicar, e o item 2 do pedido não teria como existir.
    expect(screen.getByRole("button", { name: "Ir para a mensagem citada" })).toBeInTheDocument();
    expect(screen.getByText("Toque para carregar a original")).toBeInTheDocument();

    clicarNaCitacao();

    await waitFor(() => expect(alvosDaRolagem()).toContain("m-velha"));
    expect(estado.fetchNextPage).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-message-id="m-velha"]')).not.toBeNull();
    expect(
      container.querySelector('[data-message-id="m-velha"]')?.getAttribute("data-destacada"),
    ).toBe("true");
    // A original carregada toma o lugar do rótulo genérico.
    expect(screen.queryByText("Toque para carregar a original")).toBeNull();
  });

  it("com a original apagada (linha ainda existe), o clique alcança e não quebra", async () => {
    estado.paginas = [
      {
        data: [
          msg("m-apagada", "texto que não volta mais", {
            revoked_at: "2026-09-24T12:06:00.000Z",
            sent_at: "2026-09-24T12:00:00.000Z",
          }),
          msg("m-resposta", "qual era mesmo?", {
            reply_to_message_id: "m-apagada",
            sent_at: "2026-09-24T12:05:00.000Z",
          }),
        ],
      },
    ];

    const { container } = render(<ChatThread conversationId="c-1" />, { wrapper });

    // O fio permanece (a citação some, a resposta não) e continua clicável.
    expect(screen.getByText("Esta mensagem foi apagada")).toBeInTheDocument();

    clicarNaCitacao();

    await waitFor(() => expect(alvosDaRolagem()).toContain("m-apagada"));
    expect(container.querySelector('[data-message-id="m-apagada"]')).not.toBeNull();
    expect(aviso.info).not.toHaveBeenCalled();
  });

  it("com a original inexistente, avisa em vez de não fazer nada", async () => {
    estado.paginas = [
      {
        data: [
          msg("m-orfa", "respondendo a algo que sumiu", { reply_to_message_id: "m-fantasma" }),
        ],
      },
    ];
    estado.proximas = []; // não há mais página: a original não está em lugar nenhum

    render(<ChatThread conversationId="c-1" />, { wrapper });

    clicarNaCitacao();

    await waitFor(() =>
      expect(aviso.info).toHaveBeenCalledWith("A mensagem original não está mais na conversa."),
    );
    // Não inventa rolagem para um alvo que não existe.
    expect(alvosDaRolagem()).not.toContain("m-fantasma");
    expect(estado.fetchNextPage).not.toHaveBeenCalled();
  });
});
