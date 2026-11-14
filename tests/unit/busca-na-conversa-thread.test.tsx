import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/lib/types/messaging";

/**
 * BUSCA DENTRO DA CONVERSA, NAS MENSAGENS JÁ CARREGADAS (extraída do PR #1793).
 *
 * O termo filtra o que está na tela — nunca vai ao servidor — e marca a bolha
 * inteira que bate. Aqui a `MessageBubble` é a REAL: o que se mede é a marca que
 * o atendente vê (`data-search-match` + o anel), não uma prop repassada.
 */

const estado = vi.hoisted(() => ({ mensagens: [] as unknown[] }));
const get = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/client", () => ({ apiClient: { get } }));
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

/** Os corpos das bolhas marcadas pela busca, em ordem. */
function marcadas(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-search-match="true"]')].map(
    (el) => el.querySelector('[data-testid="message-bubble"]')?.textContent ?? "",
  );
}

describe("ChatThread: busca nas mensagens carregadas", () => {
  beforeEach(() => {
    qc = new QueryClient();
    rolar.mockClear();
    get.mockClear();
    Element.prototype.scrollIntoView = rolar;
    estado.mensagens = [
      msg("m-1", "Qual o valor do BOLETO?"),
      msg("m-2", "Bom dia"),
      msg("m-3", "segue o boleto", { direction: "outbound" }),
      msg("m-4", "boleto apagado", { revoked_at: "2026-09-24T12:05:00.000Z" }),
      msg("m-5", "boleto oculto", { metadata: { crm_hidden_at: "2026-09-24T12:06:00.000Z" } }),
    ];
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  it("marca só as bolhas visíveis que contêm o termo, sem diferenciar maiúsculas", () => {
    const { container } = render(<ChatThread conversationId="c-1" searchTerm="  Boleto " />, {
      wrapper,
    });
    const achadas = marcadas(container);
    expect(achadas).toHaveLength(2);
    expect(achadas[0]).toContain("Qual o valor do BOLETO?");
    expect(achadas[1]).toContain("segue o boleto");
    expect(screen.getByRole("status")).toHaveTextContent("Resultados nas mensagens carregadas: 2");
    // O anel é o que o atendente enxerga; o atributo sozinho não pinta nada.
    const bolha = container.querySelector('[data-search-match="true"] [data-testid="message-bubble"]');
    expect(bolha?.className).toContain("ring-2");
    // Não consulta o servidor: a busca é só sobre o que já está carregado.
    expect(get).not.toHaveBeenCalled();
  });

  it("leva a primeira ocorrência ao campo de visão", () => {
    render(<ChatThread conversationId="c-1" searchTerm="boleto" />, { wrapper });
    const alvos = rolar.mock.contexts as Element[];
    expect(alvos.some((el) => el.getAttribute("data-search-match") === "true")).toBe(true);
  });

  it("termo sem ocorrência diz zero; sem termo, nada é marcado e não há contador", () => {
    const { container, rerender } = render(
      <ChatThread conversationId="c-1" searchTerm="pix" />,
      { wrapper },
    );
    expect(marcadas(container)).toEqual([]);
    expect(screen.getByRole("status")).toHaveTextContent(": 0");

    rerender(<ChatThread conversationId="c-1" searchTerm="   " />);
    expect(marcadas(container)).toEqual([]);
    expect(screen.queryByRole("status")).toBeNull();
    expect(container.querySelectorAll('[data-testid="message-bubble"]').length).toBeGreaterThan(0);
  });

  it("acha a mensagem com acento digitando SEM acento — e com acento também (#4411)", () => {
    estado.mensagens = [
      msg("m-1", "Pode mandar o orçamento?"),
      msg("m-2", "Orçamento enviado, chefe"),
      msg("m-3", "boleto em anexo"),
    ];

    // O defeito: `toLocaleLowerCase` dobra caixa, não acento — `orcamento` não
    // achava "orçamento". As duas grafias têm de devolver o MESMO conjunto.
    const { container: semAcento } = render(
      <ChatThread conversationId="c-1" searchTerm="orcamento" />,
      { wrapper },
    );
    const achadasSemAcento = marcadas(semAcento);
    expect(achadasSemAcento).toHaveLength(2);
    expect(achadasSemAcento[0]).toContain("Pode mandar o orçamento?");

    // Quem digita COM acento continua achando o que já achava: o conserto não
    // pode trocar um buraco por outro.
    const { container: comAcento } = render(
      <ChatThread conversationId="c-1" searchTerm="orçamento" />,
      { wrapper },
    );
    expect(marcadas(comAcento)).toEqual(achadasSemAcento);
  });
});
