import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A FICHA DO NEGÓCIO COM OS OUTROS NÚMEROS DO CLIENTE (#3669, fatia 1).
 *
 * Na lista "Pessoas relacionadas" (seção ① Contato do dossiê), cada pessoa
 * passa a mostrar o NÚMERO — com o comprador e o fixo da loja na mesma lista, é
 * ele que diz quem é quem — e o atalho para a CONVERSA dela. E o "+ telefone"
 * liga um número ao negócio sem ter de cadastrar o contato antes.
 *
 * Os hooks entram dublados, como em `funil-mostra-dados-do-cliente.test.tsx`:
 * o que este arquivo prova é a TELA. O caminho das rotas (acha pelo 409 do
 * cadastro ou cria, depois liga) está em `ligar-pelo-telefone.test.ts`.
 */
const useContatosRelacionados = vi.hoisted(() => vi.fn());
const ligarPeloTelefone = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/contacts/useContact", () => ({
  useContact: () => ({ data: undefined, isLoading: false, isError: true }),
}));
vi.mock("@/hooks/contacts/useContactList", () => ({
  useContactList: () => ({ data: { pages: [{ data: [] }] }, isLoading: false }),
}));
vi.mock("@/hooks/leads/useContatosRelacionados", () => ({ useContatosRelacionados }));
vi.mock("@/hooks/leads/useParticipantesDoNegocio", () => ({
  useAdicionarParticipante: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRemoverParticipante: () => ({ mutate: vi.fn(), isPending: false }),
  useAdicionarPeloTelefone: () => ({ mutateAsync: ligarPeloTelefone, isPending: false }),
}));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/kanban/useBoard", () => ({
  chaveDoQuadro: (pipelineId: string | null) => ["kanban-board", pipelineId],
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...resto }: { href: string; children: ReactNode }) => (
    <a href={href} {...resto}>
      {children}
    </a>
  ),
}));

import { ContatoDoNegocio } from "@/components/kanban/ContatoDoNegocio";

function montar() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ContatoDoNegocio contactId="c-dono" pipelineId="p-1" leadId="l-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useContatosRelacionados.mockReturnValue({ data: { data: [] }, isLoading: false, isError: false });
  ligarPeloTelefone.mockResolvedValue({ contact_id: "c-novo", jaExistia: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("dossiê — os outros números do cliente", () => {
  it("⭐ cada pessoa mostra o número e o atalho para a conversa dela", () => {
    useContatosRelacionados.mockReturnValue({
      data: {
        data: [
          {
            contact_id: "c-comprador",
            nome: "Ana",
            papel: "Comprador",
            anonimizado: false,
            telefone: "+5511987654321",
            conversa_id: "conv-ana",
          },
          // Sem conversa ainda (número ligado agora, ninguém escreveu): sem link.
          { contact_id: "c-loja", nome: null, papel: "Loja", anonimizado: false, telefone: "+551133224455" },
        ],
      },
      isLoading: false,
      isError: false,
    });
    montar();

    const lista = screen.getByTestId("pessoas-relacionadas");
    expect(within(lista).getByText("+5511987654321")).toBeInTheDocument();
    expect(within(lista).getByText("+551133224455")).toBeInTheDocument();
    const links = within(lista).getAllByRole("link", { name: /Abrir conversa com/ });
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/app/inbox?id=conv-ana"]);
    expect(links[0]).toHaveAccessibleName("Abrir conversa com Ana");
  });

  it("⭐ '+ telefone' liga o número digitado, com nome e papel, e fecha", async () => {
    montar();
    expect(screen.queryByTestId("formulario-do-telefone")).toBeNull();
    fireEvent.click(screen.getByTestId("adicionar-pelo-telefone"));

    const form = screen.getByTestId("formulario-do-telefone");
    fireEvent.change(within(form).getByLabelText("Telefone"), { target: { value: " (11) 3322-4455 " } });
    fireEvent.change(within(form).getByLabelText("Nome (opcional)"), { target: { value: "Loja Centro" } });
    fireEvent.change(within(form).getByLabelText("Papel"), { target: { value: "Loja" } });
    fireEvent.click(within(form).getByRole("button", { name: "Ligar ao negócio" }));

    await waitFor(() =>
      expect(ligarPeloTelefone).toHaveBeenCalledWith({
        telefone: "(11) 3322-4455",
        nome: "Loja Centro",
        papel: "Loja",
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Telefone ligado ao negócio."));
    await waitFor(() => expect(screen.queryByTestId("formulario-do-telefone")).toBeNull());
  });

  it("número de contato que já existia: a mensagem diz isso", async () => {
    ligarPeloTelefone.mockResolvedValue({ contact_id: "c-ana", jaExistia: true });
    montar();
    fireEvent.click(screen.getByTestId("adicionar-pelo-telefone"));
    const form = screen.getByTestId("formulario-do-telefone");
    fireEvent.change(within(form).getByLabelText("Telefone"), { target: { value: "11987654321" } });
    fireEvent.click(within(form).getByRole("button", { name: "Ligar ao negócio" }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "O contato que já tinha este número foi ligado ao negócio.",
      ),
    );
    expect(ligarPeloTelefone).toHaveBeenCalledWith({ telefone: "11987654321", nome: null, papel: null });
  });

  it("sem número, não chama nada e diz o que falta", () => {
    montar();
    fireEvent.click(screen.getByTestId("adicionar-pelo-telefone"));
    const form = screen.getByTestId("formulario-do-telefone");
    fireEvent.click(within(form).getByRole("button", { name: "Ligar ao negócio" }));

    expect(ligarPeloTelefone).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Digite o telefone.");
  });

  it("falha da API mantém o formulário aberto, com o que foi digitado", async () => {
    ligarPeloTelefone.mockRejectedValue(new Error("422"));
    montar();
    fireEvent.click(screen.getByTestId("adicionar-pelo-telefone"));
    const form = screen.getByTestId("formulario-do-telefone");
    fireEvent.change(within(form).getByLabelText("Telefone"), { target: { value: "123" } });
    fireEvent.click(within(form).getByRole("button", { name: "Ligar ao negócio" }));

    await waitFor(() => expect(ligarPeloTelefone).toHaveBeenCalled());
    expect(screen.getByTestId("formulario-do-telefone")).toBeInTheDocument();
    expect(within(screen.getByTestId("formulario-do-telefone")).getByLabelText("Telefone")).toHaveValue("123");
    expect(toast.success).not.toHaveBeenCalled();
  });
});
