/**
 * O formulário "pessoa com contato" (página da empresa e 2º passo do "Nova empresa").
 * O que importa provar, pela tela:
 *   1. gravou (201) → avisa quem chamou (`onSalvo`) e manda o corpo certo à rota da empresa;
 *   2. recusa de validação → a tela mostra a frase do CAMPO (`issues[0].message`),
 *      não o "Dados inválidos." genérico;
 *   3. recusa sem detalhe (409) → mostra a mensagem do servidor e NÃO chama `onSalvo`;
 *   4. o botão secundário ("Pular por agora" / "Cancelar") não grava nada;
 *   5. sem nome o Salvar fica desligado.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useActiveOrg: () => ({ country: "BR" }) }));

import { FormPessoaComContato } from "@/components/crm-b2b/FormPessoaComContato";

const fetchFalso = vi.fn();

function resposta(status: number, corpo: unknown) {
  return { ok: status < 400, status, json: async () => corpo } as Response;
}

function montar() {
  const onSalvo = vi.fn();
  const onSecundario = vi.fn();
  render(
    <FormPessoaComContato
      empresaId="emp-1"
      rotuloSecundario="Pular por agora"
      onSecundario={onSecundario}
      onSalvo={onSalvo}
    />,
  );
  return { onSalvo, onSecundario };
}

beforeEach(() => {
  fetchFalso.mockReset();
  vi.stubGlobal("fetch", fetchFalso);
});
afterEach(() => vi.unstubAllGlobals());

describe("FormPessoaComContato", () => {
  it("grava pela rota da empresa e avisa quem chamou", async () => {
    fetchFalso.mockResolvedValue(resposta(201, { data: {} }));
    const { onSalvo } = montar();
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Ana Souza" } });
    fireEvent.change(screen.getByLabelText("Telefone / WhatsApp"), { target: { value: "11999998888" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(onSalvo).toHaveBeenCalledTimes(1));
    const [url, init] = fetchFalso.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/companies/emp-1/contatos");
    expect(JSON.parse(init.body as string)).toMatchObject({ full_name: "Ana Souza", phone_number: "11999998888" });
  });

  it("validação recusada: mostra a frase do campo, não o texto genérico", async () => {
    fetchFalso.mockResolvedValue(
      resposta(422, {
        error: {
          message: "Dados inválidos.",
          details: { issues: [{ message: "Telefone deve ter DDD + número." }] },
        },
      }),
    );
    const { onSalvo } = montar();
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Ana" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Telefone deve ter DDD + número.");
    expect(onSalvo).not.toHaveBeenCalled();
  });

  it("telefone repetido (409): mostra a mensagem do servidor e não conclui", async () => {
    fetchFalso.mockResolvedValue(resposta(409, { error: { message: "Já existe um contato com este telefone." } }));
    const { onSalvo } = montar();
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Ana" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Já existe um contato com este telefone.");
    expect(onSalvo).not.toHaveBeenCalled();
  });

  it("o botão secundário não grava nada e sem nome o Salvar fica desligado", () => {
    const { onSecundario } = montar();
    expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Pular por agora" }));
    expect(onSecundario).toHaveBeenCalledTimes(1);
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});
