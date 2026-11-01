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

import { CaseReplyPanel } from "@/app/app/ai/cases/_components/CaseReplyPanel";

function renderWith(status: "awaiting_human" | "awaiting_lead" | "resolved" | "escalated" | "cancelled") {
  const qc = new QueryClient();
  const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
  render(
    <QueryClientProvider client={qc}>
      <CaseReplyPanel caseId="case-1" status={status} />
    </QueryClientProvider>,
  );
  return { invalidateSpy };
}

beforeEach(() => {
  postMock.mockReset();
  showApiErrorMock.mockReset();
});

describe("CaseReplyPanel", () => {
  it("desabilitado fora de awaiting_human, com explicação visível", () => {
    renderWith("awaiting_lead");

    expect(screen.getByText(/aguardando o cliente responder/i)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /concluí/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
    expect(screen.getByPlaceholderText(/escreva sua resposta/i)).toBeDisabled();
  });

  it("botão Enviar desabilitado com texto vazio, mesmo em awaiting_human", () => {
    renderWith("awaiting_human");
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
  });

  it("nenhuma ação vem pré-selecionada e o envio exige escolher uma", () => {
    // As 3 ações têm efeitos muito diferentes e uma delas FECHA o caso, sem
    // desfazer. Um default marcado faria quem digitou pensando em "pedir info ao
    // cliente" encerrar o caso sem perceber ao clicar Enviar.
    renderWith("awaiting_human");

    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toHaveAttribute("aria-checked", "false");
    }

    fireEvent.change(screen.getByPlaceholderText(/escreva sua resposta/i), {
      target: { value: "Preciso do e-mail do pedido" },
    });
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
    expect(screen.getByText(/escolha uma das opções acima/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /preciso de info do cliente/i }));
    expect(screen.getByRole("button", { name: "Enviar" })).not.toBeDisabled();
  });

  it("enviar com ação need_lead_info chama o POST com {action, body} e invalida as queries", async () => {
    postMock.mockResolvedValue({ data: { status: "awaiting_lead" } });
    const { invalidateSpy } = renderWith("awaiting_human");

    fireEvent.click(screen.getByRole("radio", { name: /preciso de info do cliente/i }));
    fireEvent.change(screen.getByPlaceholderText(/escreva sua resposta/i), {
      target: { value: "Qual seu CPF?" },
    });

    const sendBtn = screen.getByRole("button", { name: "Enviar" });
    expect(sendBtn).not.toBeDisabled();
    fireEvent.click(sendBtn);

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/ai/cases/case-1/reply", {
        action: "need_lead_info",
        body: "Qual seu CPF?",
      }),
    );
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
  });

  it("erro na mutation chama showApiError", async () => {
    postMock.mockRejectedValue(new Error("conflito"));
    renderWith("awaiting_human");

    fireEvent.click(screen.getByRole("radio", { name: /concluí/i }));
    fireEvent.change(screen.getByPlaceholderText(/escreva sua resposta/i), {
      target: { value: "Concluído, avisei o cliente." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));

    await waitFor(() => expect(showApiErrorMock).toHaveBeenCalled());
  });

  /**
   * #3810: a 4ª opção NÃO passa pelo `.../reply`. Ela tem rota própria
   * (`.../close`), corpo próprio (`{note}`, sem `action`) e rótulo próprio no
   * botão — "Enviar" seria mentira, porque nada é enviado a ninguém.
   */
  it("encerrar sem avisar o cliente chama o POST /close com {note} e invalida as queries", async () => {
    postMock.mockResolvedValue({ data: { status: "cancelled" } });
    const { invalidateSpy } = renderWith("awaiting_human");

    fireEvent.click(screen.getByRole("radio", { name: /encerrar sem avisar o cliente/i }));
    fireEvent.change(
      screen.getByPlaceholderText(/por que este caso não precisa mais de resposta/i),
      { target: { value: "o cliente comprou em outra loja" } },
    );

    const botao = screen.getByRole("button", { name: "Encerrar caso" });
    expect(botao).not.toBeDisabled();
    fireEvent.click(botao);

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/ai/cases/case-1/close", {
        note: "o cliente comprou em outra loja",
      }),
    );
    // Nenhuma chamada ao caminho que avisa o cliente.
    expect(postMock.mock.calls.some(([url]) => String(url).endsWith("/reply"))).toBe(false);
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
  });

  it("a nota do encerramento é obrigatória: sem texto o botão fica desabilitado", () => {
    renderWith("awaiting_human");

    fireEvent.click(screen.getByRole("radio", { name: /encerrar sem avisar o cliente/i }));
    expect(screen.getByRole("button", { name: "Encerrar caso" })).toBeDisabled();

    fireEvent.change(
      screen.getByPlaceholderText(/por que este caso não precisa mais de resposta/i),
      { target: { value: "   " } },
    );
    expect(screen.getByRole("button", { name: "Encerrar caso" })).toBeDisabled();
  });
});
