import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

const postMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { post: (...args: unknown[]) => postMock(...args) },
}));

const showApiErrorMock = vi.fn();
vi.mock("@/components/feedback/ApiErrorToast", () => ({
  showApiError: (...args: unknown[]) => showApiErrorMock(...args),
}));

import { DraftReplyButton } from "@/components/inbox/composer/DraftReplyButton";

function wrap(ui: React.ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  postMock.mockReset();
  showApiErrorMock.mockReset();
});

describe("DraftReplyButton", () => {
  it("clicar dispara a mutation e desabilita enquanto pendente", async () => {
    let resolvePost!: (v: unknown) => void;
    postMock.mockReturnValue(new Promise((resolve) => (resolvePost = resolve)));
    const onDraft = vi.fn();

    render(wrap(<DraftReplyButton conversationId="conv-1" onDraft={onDraft} />));
    const btn = screen.getByRole("button", { name: "Sugerir resposta" });
    fireEvent.click(btn);

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/conv-1/draft-reply", {}),
    );
    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn).toHaveAttribute("aria-busy", "true");

    resolvePost({ data: { draft: "texto sugerido" } });
    await waitFor(() => expect(onDraft).toHaveBeenCalledWith("texto sugerido"));
  });

  it("erro chama showApiError e não chama onDraft", async () => {
    postMock.mockRejectedValue(new Error("falhou"));
    const onDraft = vi.fn();

    render(wrap(<DraftReplyButton conversationId="conv-1" onDraft={onDraft} />));
    fireEvent.click(screen.getByRole("button", { name: "Sugerir resposta" }));

    await waitFor(() => expect(showApiErrorMock).toHaveBeenCalled());
    expect(onDraft).not.toHaveBeenCalled();
  });

  it("disabled prop desabilita o botão", () => {
    render(wrap(<DraftReplyButton conversationId="conv-1" onDraft={vi.fn()} disabled />));
    expect(screen.getByRole("button", { name: "Sugerir resposta" })).toBeDisabled();
  });
});
