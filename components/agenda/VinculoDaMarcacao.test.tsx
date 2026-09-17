/**
 * Criar contato SEM sair da marcação.
 *
 * O que esta suíte protege: quem marca horário costuma estar com a pessoa na
 * frente, e ela nem sempre já é contato. Antes deste atalho o fluxo PARAVA aqui
 * — era preciso abandonar a marcação, ir até Contatos, criar, voltar e
 * recomeçar. O termo digitado vira o nome, e o contato volta **selecionado**.
 *
 * O caso 3 é o que mais importa e o mais fácil de quebrar numa refatoração: se
 * `onCriado` deixar de propagar o id, o contato nasce e a marcação continua sem
 * ninguém — sem erro nenhum na tela.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VinculoDaMarcacao } from "./VinculoDaMarcacao";

const get = vi.fn();
vi.mock("@/lib/api/client", () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

// O diálogo real arrasta formulário, toasts e mutation. Aqui interessa o FIO:
// ele recebe o nome digitado e devolve o contato criado?
vi.mock("@/components/contacts/NewContactDialog", () => ({
  NewContactDialog: ({
    open,
    nomeInicial,
    onCriado,
  }: {
    open: boolean;
    nomeInicial?: string;
    onCriado?: (c: { id: string; name: string }) => void;
  }) =>
    open ? (
      <div>
        <span data-testid="nome-recebido">{nomeInicial}</span>
        <button type="button" onClick={() => onCriado?.({ id: "c-99", name: "Joana Prado" })}>
          simular criação
        </button>
      </div>
    ) : null,
}));

function envolver(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function responderCom(contacts: Array<{ id: string; name: string }>) {
  get.mockResolvedValue({ data: { contacts, conversations: [] } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("VinculoDaMarcacao", () => {
  it("oferece criar quando a busca não encontra ninguém", async () => {
    responderCom([]);
    const user = userEvent.setup();
    envolver(<VinculoDaMarcacao contactId="" conversationId="" onChange={vi.fn()} />);

    await user.type(screen.getByLabelText(/Buscar cliente/i), "Joana");

    await waitFor(() => expect(screen.getByRole("button", { name: /Criar/i })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Joana/ })).toBeInTheDocument();
  });

  it("NÃO oferece criar quando a busca encontra alguém", async () => {
    responderCom([{ id: "c-1", name: "Joana Prado" }]);
    const user = userEvent.setup();
    envolver(<VinculoDaMarcacao contactId="" conversationId="" onChange={vi.fn()} />);

    await user.type(screen.getByLabelText(/Buscar cliente/i), "Joana");

    await waitFor(() => expect(screen.getByRole("option", { name: "Joana Prado" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Criar/i })).not.toBeInTheDocument();
  });

  it("leva o nome digitado e devolve o contato JÁ SELECIONADO", async () => {
    responderCom([]);
    const onChange = vi.fn();
    const user = userEvent.setup();
    envolver(<VinculoDaMarcacao contactId="" conversationId="" onChange={onChange} />);

    await user.type(screen.getByLabelText(/Buscar cliente/i), "Joana");
    await waitFor(() => expect(screen.getByRole("button", { name: /Criar/i })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Criar/i }));

    // o que foi digitado chega ao diálogo, para não redigitar
    expect(screen.getByTestId("nome-recebido")).toHaveTextContent("Joana");

    await user.click(screen.getByRole("button", { name: /simular criação/i }));

    // e o contato volta selecionado — é isto que evita procurar o que acabou de criar
    expect(onChange).toHaveBeenCalledWith("c-99", "");
  });

  it("não oferece criar antes de digitar", async () => {
    responderCom([]);
    envolver(<VinculoDaMarcacao contactId="" conversationId="" onChange={vi.fn()} />);

    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Criar/i })).not.toBeInTheDocument();
  });
});
