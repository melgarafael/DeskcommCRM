import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type * as UseCasesModule from "@/hooks/ai/useCases";

const useCasesMock = vi.fn();
vi.mock("@/hooks/ai/useCases", async () => {
  const actual = await vi.importActual<typeof UseCasesModule>("@/hooks/ai/useCases");
  return { ...actual, useCases: (...args: unknown[]) => useCasesMock(...args) };
});

// CaseDetail é testado à parte; aqui só a lista importa.
vi.mock("@/app/app/ai/cases/_components/CaseDetail", () => ({
  CaseDetail: () => null,
}));

import { CaseList } from "@/app/app/ai/cases/_components/CaseList";

function wrap(ui: React.ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;
}

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

    render(wrap(<CaseList />));

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

    render(wrap(<CaseList />));

    expect(screen.getByText("Nenhum caso aberto")).toBeInTheDocument();
    // O membro achou que o repasse para humano cairia aqui (DES-49): o texto diz
    // quem abre caso (o interruptor exato) e para onde vai a conversa passada a uma pessoa.
    const explicacao = screen.getByText(/os casos aparecem aqui/i);
    expect(explicacao.textContent).toContain(
      '"Deixar o agente pedir uma tarefa a alguém e seguir conversando"',
    );
    expect(explicacao.textContent).toMatch(/agente publicado/);
    expect(explicacao.textContent).toMatch(/vai para o Inbox/);
    expect(screen.queryByText(/quando a ia precisar de você/i)).not.toBeInTheDocument();
  });
});
