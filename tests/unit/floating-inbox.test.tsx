import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const state = vi.hoisted(() => ({
  org: "org-a",
  readonly: false,
  blocked: false,
  closed: false,
  unread: 104,
  mark: vi.fn(),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    activeOrg: { orgId: state.org },
    user: { id: "user", support: state.readonly ? { access_mode: "support_readonly" } : undefined },
  }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/voice/VoiceCallContext", () => ({
  useVoiceCall: () => ({ call: null, minha: false }),
}));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({ useRealtimeChannel: vi.fn() }));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({ data: { all: state.unread } }),
}));
vi.mock("@/hooks/inbox/useConversationsRealtime", () => ({
  useConversationsRealtime: () => ({ data: { pages: [{ data: [{ id: "one" }, { id: "two" }] }] } }),
}));
vi.mock("@/hooks/inbox/useConversation", () => ({
  useConversation: () => ({
    data: {
      status: state.closed ? "closed" : "open",
      contact_id: "contact",
      unread_count_for_assignee: 3,
      contacts: { name: "Cliente", is_blocked: state.blocked },
      channel_sessions: { provider: "waha" },
    },
  }),
}));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({
  useMarkAsRead: (...args: unknown[]) => state.mark(...args),
}));
vi.mock("@/components/inbox/ConversationListItem", () => ({
  ConversationListItem: ({
    conversation,
    onSelect,
  }: {
    conversation: { id: string };
    onSelect: (id: string) => void;
  }) => <button onClick={() => onSelect(conversation.id)}>{conversation.id}</button>,
}));
vi.mock("@/components/inbox/ChannelLogo", () => ({ ChannelLogo: () => null }));
vi.mock("@/components/inbox/JanelaSelo", () => ({ JanelaSelo: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => <div>Histórico</div> }));
const mutations = vi.hoisted(() => ({ send: vi.fn(), note: vi.fn() }));
vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: mutations.send, isPending: false }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: mutations.note, isPending: false }),
}));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/hooks/inbox/useDraftReply", () => ({
  useDraftReply: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("next/dynamic", async () => {
  const { lazy, Suspense } = await import("react");
  return {
    default: (loader: () => Promise<unknown>) => {
      const Component = lazy(async () => ({ default: (await loader()) as React.ComponentType }));
      return function Lazy(props: Record<string, unknown>) {
        return (
          <Suspense fallback={null}>
            <Component {...props} />
          </Suspense>
        );
      };
    },
  };
});

import { FloatingInbox } from "@/components/inbox/FloatingInbox";
function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}
function mount() {
  return render(<FloatingInbox />, { wrapper: Wrapper });
}
async function select(id = "one") {
  fireEvent.click(screen.getByRole("button", { name: /Mensagens/ }));
  fireEvent.click(screen.getByRole("button", { name: id }));
  if (state.readonly || state.blocked)
    await screen.findByText(
      state.readonly
        ? "Acompanhamento somente leitura"
        : "Contato bloqueado — envio de mensagens desabilitado.",
    );
  else await screen.findByRole("textbox", { name: "Mensagem" });
}
beforeEach(() => {
  Object.assign(state, {
    org: "org-a",
    readonly: false,
    blocked: false,
    closed: false,
    unread: 104,
  });
  state.mark.mockClear();
});
it("starts minimized and counts all unread conversations, not loaded rows", () => {
  mount();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.getByLabelText("104 conversas não lidas")).toHaveTextContent("99+");
});
it("preserves the draft when minimized and stops marking the hidden thread as read", async () => {
  mount();
  await select();
  fireEvent.change(screen.getByRole("textbox", { name: "Mensagem" }), {
    target: { value: "rascunho" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Minimizar mensagens" }));
  expect(state.mark).toHaveBeenLastCalledWith(null, 3);
  fireEvent.click(screen.getByRole("button", { name: /Mensagens/ }));
  expect(screen.getByRole("textbox", { name: "Mensagem" })).toHaveValue("rascunho");
  expect(state.mark).toHaveBeenLastCalledWith("one", 3);
});
it("keeps separate drafts when switching conversations", async () => {
  mount();
  await select();
  fireEvent.change(screen.getByRole("textbox", { name: "Mensagem" }), {
    target: { value: "para um" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Voltar às conversas" }));
  fireEvent.click(screen.getByRole("button", { name: "two" }));
  expect(await screen.findByRole("textbox", { name: "Mensagem" })).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "Voltar às conversas" }));
  fireEvent.click(screen.getByRole("button", { name: "one" }));
  expect(await screen.findByRole("textbox", { name: "Mensagem" })).toHaveValue("para um");
});
it.each(["readonly", "blocked", "closed"] as const)("preserves the %s send guard", async (key) => {
  state[key] = true;
  mount();
  await select();
  if (key === "closed") expect(screen.getByRole("textbox", { name: "Mensagem" })).toBeDisabled();
  else expect(screen.queryByRole("textbox", { name: "Mensagem" })).not.toBeInTheDocument();
});
it("clears selection and drafts when organization changes", async () => {
  const view = mount();
  await select();
  fireEvent.change(screen.getByRole("textbox", { name: "Mensagem" }), {
    target: { value: "privado" },
  });
  state.org = "org-b";
  view.rerender(<FloatingInbox />);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  await select();
  expect(screen.getByRole("textbox", { name: "Mensagem" })).toHaveValue("");
});
it("Escape minimizes and returns focus to the trigger; maximize points to the selected thread", async () => {
  mount();
  await select();
  expect(screen.getByRole("link", { name: "Abrir no Inbox" })).toHaveAttribute(
    "href",
    "/app/inbox/one",
  );
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Mensagem" }), { key: "Escape" });
  await waitFor(() => expect(screen.getByRole("button", { name: /Mensagens/ })).toHaveFocus());
});

it("restores a private note as a note, never as an external reply", async () => {
  mutations.send.mockClear();
  mutations.note.mockClear();
  mount();
  await select();
  fireEvent.click(screen.getByRole("button", { name: "Nota interna" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Mensagem" }), {
    target: { value: "anotação confidencial" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Voltar às conversas" }));
  fireEvent.click(screen.getByRole("button", { name: "two" }));
  await screen.findByRole("textbox", { name: "Mensagem" });
  fireEvent.click(screen.getByRole("button", { name: "Voltar às conversas" }));
  fireEvent.click(screen.getByRole("button", { name: "one" }));
  expect(await screen.findByPlaceholderText(/nota interna/i)).toHaveValue("anotação confidencial");
  fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
  expect(mutations.note).toHaveBeenCalled();
  expect(mutations.send).not.toHaveBeenCalled();
});
it("unmounts the microphone control while minimized", async () => {
  mount();
  await select();
  expect(screen.getByRole("button", { name: "Gravar áudio" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Minimizar mensagens" }));
  expect(
    screen.queryByRole("button", { name: "Gravar áudio", hidden: true }),
  ).not.toBeInTheDocument();
});
