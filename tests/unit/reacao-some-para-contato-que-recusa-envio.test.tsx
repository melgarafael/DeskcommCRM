import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "@/lib/types/messaging";

/**
 * Contato bloqueado (opt-out) ou pessoal: a rota de reação recusa com 403, então
 * o menu do balão não oferece reagir (#4194). Os outros gestos continuam.
 */

vi.mock("@/hooks/inbox/useMessagesRealtime", () => ({
  useMessagesRealtime: () => ({
    data: { pages: [{ data: [mensagem] }] },
    isLoading: false, isError: false, hasNextPage: false, isFetchingNextPage: false,
    fetchNextPage: vi.fn(), refetch: vi.fn(),
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

const mensagem = {
  id: "m-1", organization_id: "o1", conversation_id: "c-1", channel_session_id: "s1",
  contact_id: "ct1", external_id: "false_5511@c.us_ABC", type: "text", direction: "inbound",
  status: "delivered", body: "Oi", sent_via: "external_device", sent_by_user_id: null,
  sent_at: "2026-11-10T12:00:00.000Z", created_at: "2026-11-10T12:00:00.000Z",
  metadata: {}, revoked_at: null, reply_to_message_id: null,
} as unknown as Message;

function abrir(contatoRecusaEnvio: boolean) {
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  render(<ChatThread conversationId="c-1" provider="waha" onResponder={() => undefined} contatoRecusaEnvio={contatoRecusaEnvio} />, { wrapper });
}

describe("reação no fio x contato que recusa envio", () => {
  it.each([
    [false, 5],
    [true, 0],
  ])("contatoRecusaEnvio=%s mostra %i emojis no menu", async (recusa, quantos) => {
    Element.prototype.scrollIntoView = vi.fn();
    const user = userEvent.setup();
    abrir(recusa);
    await user.click(screen.getByRole("button", { name: "Opções da mensagem" }));
    expect(screen.queryAllByRole("menuitem", { name: /^Reagir com / })).toHaveLength(quantos);
    // O menu continua: só a reação sai.
    expect(screen.getByRole("menuitem", { name: /Responder/ })).toBeInTheDocument();
  });
});
