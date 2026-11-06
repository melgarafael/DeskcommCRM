import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/lib/types/messaging";

const state = vi.hoisted(() => ({ messages: [] as Message[], pages: 1, older: false, fetch: vi.fn() }));
vi.mock("@/hooks/inbox/useMessagesRealtime", () => ({ useMessagesRealtime: () => ({
  data: { pages: Array.from({ length: state.pages }, (_, i) => ({ data: i === 0 ? state.messages : [] })) },
  isLoading: false, isError: false, hasNextPage: state.older, isFetchingNextPage: false,
  fetchNextPage: state.fetch, refetch: vi.fn(),
}) }));
vi.mock("@/hooks/inbox/useConversationNotes", () => ({ useConversationNotes: () => [] }));
vi.mock("@/hooks/inbox/usePassagensDaConversa", () => ({ usePassagensDaConversa: () => [] }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({ useClaimConversation: () => ({ mutate: vi.fn() }) }));
vi.mock("@/hooks/inbox/useDeleteNote", () => ({ useDeleteNote: () => ({ mutate: vi.fn() }) }));
vi.mock("@/hooks/inbox/useAlterarMensagem", () => ({ useAlterarMensagem: () => ({ editar: {}, apagar: {}, ocultar: {}, restaurar: {} }) }));
vi.mock("@/hooks/ai/useDebugToggle", () => ({ useDebugToggle: () => ({ enabled: false }) }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useActiveOrg: () => ({ role: "agent" }), useUser: () => ({ id: "u-1" }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
vi.mock("@/components/inbox/MessageBubble", () => ({ MessageBubble: ({ message }: { message: Message }) => <div>{message.body}</div> }));
vi.mock("@/components/inbox/NoteCard", () => ({ NoteCard: () => null }));
vi.mock("@/components/inbox/PassagemCard", () => ({ PassagemCard: () => null }));
import { ChatThread } from "@/components/inbox/ChatThread";

const scroll = vi.fn();
const originalScroll = Element.prototype.scrollIntoView;
const resizeCallbacks = new Set<() => void>();
class ResizeObserverFixture {
  callback: () => void;
  constructor(callback: () => void) { this.callback = callback; resizeCallbacks.add(callback); }
  observe() {}
  disconnect() { resizeCallbacks.delete(this.callback); }
}
function message(n: number, own: "real" | "optimistic" | false = false): Message {
  return { id: own === "optimistic" ? `temp-${n}` : `m-${n}`, body: `Mensagem ${n}`,
    sent_at: new Date(Date.UTC(2026, 9, 21, 12, 0, n)).toISOString(), direction: own ? "outbound" : "inbound",
    sent_by_user_id: own === "real" ? "u-1" : null, metadata: own === "optimistic" ? { _optimistic: true } : {},
  } as Message;
}
function geometry(scroller: HTMLElement, height = 1500, viewport = 500, top = height - viewport) {
  const values = { height, viewport, top };
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, get: () => values.height },
    clientHeight: { configurable: true, get: () => values.viewport },
    scrollTop: { configurable: true, get: () => values.top, set: (v: number) => {
      values.top = Math.max(0, Math.min(v, values.height - values.viewport));
    } },
  });
  fireEvent.scroll(scroller);
  return values;
}
function mount() {
  state.messages = [message(1)];
  const view = render(<ChatThread conversationId="c-1" />);
  const scroller = screen.getByTestId("chat-thread").querySelector<HTMLElement>(".overflow-y-auto")!;
  const metrics = geometry(scroller);
  scroll.mockClear();
  return { ...view, scroller, metrics };
}
function readingHistory(scroller: HTMLElement, metrics: ReturnType<typeof geometry>) {
  fireEvent.wheel(scroller, { deltaY: -500 });
  metrics.top = 100;
  fireEvent.scroll(scroller);
}
function resize() { act(() => { for (const callback of resizeCallbacks) callback(); }); }

describe("ChatThread: novas mensagens, histórico e viewport", () => {
  beforeEach(() => {
    state.messages = []; state.pages = 1; state.older = false; state.fetch.mockClear(); scroll.mockClear();
    vi.stubGlobal("ResizeObserver", ResizeObserverFixture);
    Element.prototype.scrollIntoView = scroll;
  });
  afterEach(() => { Element.prototype.scrollIntoView = originalScroll; vi.restoreAllMocks(); vi.unstubAllGlobals(); resizeCallbacks.clear(); });

  it("acompanha uma mensagem longa mesmo que ela aumente a distância em mais de120px", () => {
    const { rerender, metrics } = mount();
    metrics.height += 700;
    state.messages = [...state.messages, message(2)];
    rerender(<ChatThread conversationId="c-1" />);
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
  });
  it("acompanha a nova última mensagem quando a janela continua com50itens", () => {
    state.messages = Array.from({ length: 50 }, (_, i) => message(i + 1));
    const { rerender } = render(<ChatThread conversationId="c-1" />);
    const scroller = screen.getByTestId("chat-thread").querySelector<HTMLElement>(".overflow-y-auto")!;
    const metrics = geometry(scroller);scroll.mockClear();
    metrics.height += 300;
    state.messages = [...state.messages.slice(1), message(51)];
    rerender(<ChatThread conversationId="c-1" />);
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
  });
  it.each(["real", "optimistic"] as const)("envio próprio %s leva ao fim mesmo após ler o histórico", (own) => {
    const { rerender, scroller, metrics } = mount();readingHistory(scroller, metrics);
    state.messages = [...state.messages, message(2, own)];
    rerender(<ChatThread conversationId="c-1" />);
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
    expect(screen.queryByRole("button", { name: "Novas mensagens · Ir para o fim" })).toBeNull();
  });
  it("recebimento durante leitura antiga avisa sem roubar a posição, e o botão leva ao fim", () => {
    const { rerender, scroller, metrics } = mount();readingHistory(scroller, metrics);
    state.messages = [...state.messages, message(2)];metrics.height += 500;
    rerender(<ChatThread conversationId="c-1" />);
    expect(scroll).not.toHaveBeenCalled();expect(metrics.top).toBe(100);
    fireEvent.click(screen.getByRole("button", { name: "Novas mensagens · Ir para o fim" }));
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
    expect(screen.queryByRole("button", { name: "Novas mensagens · Ir para o fim" })).toBeNull();
  });
  it("a rolagem manual até o fim limpa o aviso e volta a acompanhar", () => {
    const { rerender, scroller, metrics } = mount();readingHistory(scroller, metrics);
    state.messages = [...state.messages, message(2)];rerender(<ChatThread conversationId="c-1" />);
    metrics.top = metrics.height - metrics.viewport;fireEvent.scroll(scroller);
    expect(screen.queryByRole("button", { name: "Novas mensagens · Ir para o fim" })).toBeNull();
    state.messages = [...state.messages, message(3)];rerender(<ChatThread conversationId="c-1" />);
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
  });
  it("carregar antigas preserva a âncora pelo crescimento acima e não vai ao rodapé", () => {
    state.older = true;
    const { rerender, scroller, metrics } = mount();readingHistory(scroller, metrics);
    fireEvent.click(screen.getByRole("button", { name: "Carregar mais antigas" }));
    expect(state.fetch).toHaveBeenCalledOnce();
    state.pages = 2;state.messages = [message(0), ...state.messages];metrics.height += 800;
    rerender(<ChatThread conversationId="c-1" />);
    expect(scroll).not.toHaveBeenCalled();expect(metrics.top).toBe(900);
  });
  it("mantém o final quando uma imagem ou cartão cresce depois de renderizar", () => {
    const { scroller, metrics } = mount();metrics.height += 600;resize();
    expect(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop).toBe(0);
  });
  it("acompanha a redução de altura pelo teclado móvel", () => {
    const { scroller, metrics } = mount();metrics.viewport = 240;resize();
    expect(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop).toBe(0);
  });
  it("o scroll emitido pelo reflow antes do resize não é confundido com leitura do histórico", () => {
    const { scroller, metrics } = mount();
    metrics.height += 1500;metrics.viewport = 240;
    fireEvent.scroll(scroller); // native viewport reflow, no wheel/touch/key gesture
    resize();
    expect(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop).toBe(0);
  });
  it("redimensionar não arranca a leitura do histórico", () => {
    const { scroller, metrics } = mount();readingHistory(scroller, metrics);
    metrics.height += 600;metrics.viewport = 240;resize();expect(metrics.top).toBe(100);
  });
  it("uma rajada durante a animação segue o destino até o fim", () => {
    const { rerender, scroller, metrics } = mount();metrics.height += 700;
    state.messages = [...state.messages, message(2)];rerender(<ChatThread conversationId="c-1" />);
    fireEvent.scroll(scroller); // intermediate smooth scroll is still far from the destination
    scroll.mockClear();state.messages = [...state.messages, message(3)];metrics.height += 700;
    rerender(<ChatThread conversationId="c-1" />);
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
  });
  it.each(["keyboard", "wheel"] as const)("um gesto %s sem deslocamento no fim não desliga o acompanhamento", (gesture) => {
    const { rerender, scroller, metrics } = mount();
    if (gesture === "keyboard") fireEvent.keyDown(scroller, { key: "End" });
    else fireEvent.wheel(scroller, { deltaY: 200 });
    // At the bottom the browser emits no scroll event because nothing moved.
    metrics.height += 500;state.messages = [...state.messages, message(2)];
    rerender(<ChatThread conversationId="c-1" />);
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
  });
  it("trocar de conversa limpa o aviso e abre a seguinte no fim instantaneamente", () => {
    const { rerender, scroller, metrics } = mount();readingHistory(scroller, metrics);
    state.messages = [...state.messages, message(2)];rerender(<ChatThread conversationId="c-1" />);
    rerender(<ChatThread conversationId="c-2" />);
    expect(scroll).toHaveBeenCalledWith({ behavior: "auto", block: "end" });
    expect(screen.queryByRole("button", { name: "Novas mensagens · Ir para o fim" })).toBeNull();
  });
});
