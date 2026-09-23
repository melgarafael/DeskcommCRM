import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSendMessage } from "@/hooks/inbox/useSendMessage";
import type { Message } from "@/lib/types/messaging";

const post = vi.fn();
vi.mock("@/lib/api/client", () => ({ apiClient: { post: (...args: unknown[]) => post(...args) } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

const conversationId = "44444444-4444-4444-8444-444444444444";
type Page = { data: Message[]; meta: { cursor: string | null; has_more: boolean } };

function message(id: string, body: string): Message {
  return {
    id,
    conversation_id: conversationId,
    body,
    sent_at: "2026-09-23T18:00:00.000Z",
  } as Message;
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData<InfiniteData<Page>>(["messages", conversationId], {
    pageParams: [undefined, "older"],
    pages: [
      { data: [message("recent", "Recente")], meta: { cursor: "older", has_more: true } },
      { data: [message("old", "Antiga")], meta: { cursor: null, has_more: false } },
    ],
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useSendMessage(), { wrapper });
  const pages = () => qc.getQueryData<InfiniteData<Page>>(["messages", conversationId])!.pages;
  return { hook, pages, qc };
}

afterEach(() => post.mockReset());

describe("envio no inbox", () => {
  it("mostra a resposta na página recente e substitui o provisório sem duplicar o evento do Realtime", async () => {
    let finish!: (value: { data: Message }) => void;
    post.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { hook, pages, qc } = setup();

    act(() => hook.result.current.mutate({ conversation_id: conversationId, body: "Resposta" }));
    await waitFor(() => expect(pages()[0]!.data).toHaveLength(2));
    expect(pages()[0]!.data[1]!.id).toMatch(/^temp-/);
    expect(pages()[1]!.data.map((m) => m.id)).toEqual(["old"]);

    const real = message("server-id", "Resposta");
    // O canal pode entregar a linha real antes da resposta HTTP.
    qc.setQueryData<InfiniteData<Page>>(["messages", conversationId], (old) => ({
      ...old!,
      pages: [{ ...old!.pages[0]!, data: [...old!.pages[0]!.data, real] }, old!.pages[1]!],
    }));
    await act(async () => finish({ data: real }));
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(
      pages()
        .flatMap((p) => p.data)
        .map((m) => m.id),
    ).toEqual(["recent", "server-id", "old"]);
  });

  it("remove somente o provisório quando a API falha e preserva o histórico", async () => {
    let fail!: (error: Error) => void;
    post.mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    const { hook, pages } = setup();

    act(() => hook.result.current.mutate({ conversation_id: conversationId, body: "Resposta" }));
    await waitFor(() => expect(pages()[0]!.data).toHaveLength(2));
    await act(async () => fail(new Error("Falha de rede")));
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(
      pages()
        .flatMap((p) => p.data)
        .map((m) => m.id),
    ).toEqual(["recent", "old"]);
  });
});
