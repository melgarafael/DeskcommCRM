import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EscolhaDoCliente } from "@/components/agenda/EscolhaDoCliente";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

/**
 * Dois campos em sequência para UMA escolha.
 *
 * O painel de marcação tinha "Buscar cliente" (texto) e "Quem será atendido"
 * (lista), um embaixo do outro. Quem opera relatou a confusão pela tela: o
 * segundo parecia que ia abrir algo ao digitar, e o primeiro parecia não fazer
 * nada até a lista mudar.
 */

const CONTATOS = [
  { id: "c1", name: "Ana Ribeiro", email: "ana@exemplo.com" },
  { id: "c2", name: "Bruno Alves", email: null },
];

function montar(props: Partial<React.ComponentProps<typeof EscolhaDoCliente>> = {}) {
  return render(
    <IdiomaProvider locale="pt">
      <EscolhaDoCliente
        contatos={CONTATOS}
        valor=""
        busca=""
        onBusca={() => {}}
        onEscolhe={() => {}}
        {...props}
      />
    </IdiomaProvider>,
  );
}

afterEach(cleanup);

describe("escolher o cliente num campo só", () => {
  it("⛔ abre SEM cliente — 'compromisso pessoal' é o padrão", () => {
    // O caso degenerado é o que manda no desenho: um seletor que abre já
    // apontando para o primeiro contato marca compromisso no nome de OUTRA
    // pessoa. Já aconteceu nesta instalação, por herança da abertura anterior.
    montar();
    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(screen.getByText(/compromisso pessoal/i)).toBeInTheDocument();
  });

  it("digitar filtra ali mesmo — não há segundo campo", () => {
    const onBusca = vi.fn();
    montar({ onBusca });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Ana" } });
    expect(onBusca).toHaveBeenCalledWith("Ana");
    expect(screen.queryByLabelText(/quem será atendido/i)).not.toBeInTheDocument();
  });

  it("escolher devolve o id do contato", () => {
    const onEscolhe = vi.fn();
    montar({ busca: "Ana", onEscolhe });
    fireEvent.focus(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: /Ana Ribeiro/ }));
    expect(onEscolhe).toHaveBeenCalledWith("c1");
  });

  it("com cliente escolhido, mostra o nome em vez da busca", () => {
    montar({ valor: "c1" });
    expect(screen.getByText("Ana Ribeiro")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("⛔ CONTROLE: tirar o cliente volta ao compromisso pessoal", () => {
    // O caminho de volta importa tanto quanto o de ida: sem ele, quem escolheu
    // o contato errado não tem como desfazer sem fechar o painel — e fechar o
    // painel é justamente o gesto que já causou a herança de cliente.
    const onEscolhe = vi.fn();
    const onBusca = vi.fn();
    montar({ valor: "c1", onEscolhe, onBusca });
    fireEvent.click(screen.getByRole("button", { name: /tirar o cliente/i }));
    expect(onEscolhe).toHaveBeenCalledWith("");
    expect(onBusca).toHaveBeenCalledWith("");
  });

  it("lista vazia não quebra nem mente", () => {
    montar({ contatos: [] });
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});
