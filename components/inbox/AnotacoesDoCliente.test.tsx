/**
 * ANOTAÇÕES DO CLIENTE no Inbox.
 *
 *  1. sem anotação: quem edita vê "Adicionar anotação"; quem só lê vê o aviso;
 *  2. com anotação: o texto aparece como nota, e o lápis abre a edição;
 *  3. salvar RELÊ a ficha e troca só `diag_observacoes` — os outros campos do
 *     contato, gravados por outro caminho, ficam como estão no servidor.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  campos: {} as Record<string, unknown>,
  relido: {} as Record<string, unknown>,
  atualizar: vi.fn(),
}));

vi.mock("@/hooks/contacts/useContact", () => ({
  useContact: () => ({ data: { data: { custom_fields: estado.campos } }, isLoading: false }),
}));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutateAsync: estado.atualizar, isPending: false }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(async () => ({ data: { custom_fields: estado.relido } })) },
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AnotacoesDoCliente } from "./AnotacoesDoCliente";

const CONTATO = "44444444-4444-4444-8444-444444444444";
const USUARIO = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  estado.campos = {};
  estado.relido = {};
  estado.atualizar.mockReset().mockResolvedValue({});
});

describe("Anotações do cliente", () => {
  it("sem anotação: quem edita vê o botão; quem só lê vê o aviso", () => {
    const { unmount } = render(<AnotacoesDoCliente contactId={CONTATO} usuarioId={USUARIO} podeEditar />);
    expect(screen.getByTestId("adicionar-anotacao")).toBeTruthy();
    unmount();

    render(<AnotacoesDoCliente contactId={CONTATO} usuarioId={USUARIO} podeEditar={false} />);
    expect(screen.queryByTestId("adicionar-anotacao")).toBeNull();
    expect(screen.getByText("Nenhuma anotação sobre este cliente.")).toBeTruthy();
  });

  it("com anotação: o texto aparece e o lápis abre a edição com ele", () => {
    estado.campos = { diag_observacoes: "Loja de enxoval em Recife.\nEntregar à tarde." };
    render(<AnotacoesDoCliente contactId={CONTATO} usuarioId={USUARIO} podeEditar />);

    expect(screen.getByTestId("anotacao-do-cliente").textContent).toContain("Entregar à tarde.");
    fireEvent.click(screen.getByTestId("editar-anotacao"));
    expect((screen.getByTestId("texto-da-anotacao") as HTMLTextAreaElement).value).toContain("Loja de enxoval");
  });

  it("salvar relê a ficha e troca só a anotação", async () => {
    // Na RELEITURA há um campo que outro caminho gravou depois que o bloco abriu.
    estado.relido = { tamanho: "M", segmento: "Varejo infantil" };
    render(<AnotacoesDoCliente contactId={CONTATO} usuarioId={USUARIO} podeEditar />);

    fireEvent.click(screen.getByTestId("adicionar-anotacao"));
    fireEvent.change(screen.getByTestId("texto-da-anotacao"), { target: { value: "Compra no atacado todo mês." } });
    fireEvent.click(screen.getByTestId("salvar-anotacao"));

    await waitFor(() => expect(estado.atualizar).toHaveBeenCalled());
    expect(estado.atualizar).toHaveBeenCalledWith({
      custom_fields: { tamanho: "M", segmento: "Varejo infantil", diag_observacoes: "Compra no atacado todo mês." },
    });
  });
});
