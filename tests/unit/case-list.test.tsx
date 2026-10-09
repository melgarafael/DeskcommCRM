import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type * as UseCasesModule from "@/hooks/ai/useCases";

const useCasesMock = vi.fn();
const refetchMock = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/ai/useCases", async () => {
  const actual = await vi.importActual<typeof UseCasesModule>("@/hooks/ai/useCases");
  return { ...actual, useCases: (...args: unknown[]) => useCasesMock(...args) };
});
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
// CaseDetail é testado à parte; aqui só a lista importa.
vi.mock("@/app/app/ai/cases/_components/CaseDetail", () => ({
  CaseDetail: () => null,
}));

import { CaseList } from "@/app/app/ai/cases/_components/CaseList";

describe("CaseList", () => {
  it("renderiza os casos com o rótulo pt-br do status (nunca o enum cru)", () => {
    useCasesMock.mockReturnValue({
      isLoading: false,
      data: {
        open_count: 2,
        cases: [
          {
            id: "case-1",
            title: "Cliente pede desconto acima do permitido",
            summary: "Quer 30% de desconto",
            blocker: "Fora da política de descontos",
            status: "awaiting_human",
            opened_at: new Date().toISOString(),
            conversation_id: "conv-1",
            contact_name: "Maria Silva",
            contact_phone: "+5511999990000",
          },
          {
            id: "case-2",
            title: "Aguardando CPF do cliente",
            summary: "Precisa do CPF pra emitir nota",
            blocker: "Não tem o CPF",
            status: "awaiting_lead",
            opened_at: new Date().toISOString(),
            conversation_id: "conv-2",
            contact_name: "João Souza",
            contact_phone: "+5511988880000",
          },
        ],
      },
    });

    render(<CaseList />);

    expect(screen.getByText("Cliente pede desconto acima do permitido")).toBeInTheDocument();
    expect(screen.getByText("Aguardando você")).toBeInTheDocument();
    expect(screen.getByText("Aguardando o cliente")).toBeInTheDocument();
    expect(screen.queryByText("awaiting_human")).not.toBeInTheDocument();
    expect(screen.queryByText("awaiting_lead")).not.toBeInTheDocument();
  });

  it("estado vazio ensina o que é um caso", () => {
    useCasesMock.mockReturnValue({
      isLoading: false,
      data: { open_count: 0, cases: [] },
    });

    render(<CaseList />);

    expect(screen.getByText("Nenhum caso aberto")).toBeInTheDocument();
    expect(screen.getByText(/quando a ia precisar de você/i)).toBeInTheDocument();
  });

  it("distingue erro de consulta de uma fila vazia e oferece retry", () => {
    refetchMock.mockReset();
    useCasesMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: refetchMock,
    });

    render(<CaseList />);

    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível carregar os casos");
    expect(screen.queryByText("Nenhum caso aberto")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(refetchMock).toHaveBeenCalledOnce();
  });
});
