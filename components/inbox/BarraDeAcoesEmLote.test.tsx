/**
 * A barra de ações do lote da Inbox (#2484, fatia F1).
 *
 * O que este teste prende:
 *
 * 1. A barra SÓ EXISTE com seleção — `quantidade === 0` não renderiza nada.
 *    Uma barra permanente na coluna estreita da lista é ruído que o olho
 *    aprende a ignorar, e ela mora justamente onde ficam as ações de risco.
 * 2. Cada botão chama o seu handler com o que a barra tem em mãos — a barra
 *    não sabe de ids nem de organização: ela só delega.
 * 3. O "Transferir para…" passa pelo MESMO caminho das conversas individuais:
 *    escolhe o atendente e devolve `(to_user_id, reason)` para quem monta o
 *    lote — sem destino escolhido, o confirmar fica desligado.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BarraDeAcoesEmLote } from "./BarraDeAcoesEmLote";

vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({
    data: [{ user_id: "user-destino-1", role: "agent", full_name: "Bruno" }],
    isLoading: false,
  }),
}));

const DESTINO = "user-destino-1";

function mao() {
  return {
    onFechar: vi.fn(),
    onArquivar: vi.fn(),
    onMarcarComoLida: vi.fn(),
    onPausarIa: vi.fn(),
    onDevolverAoAutomatico: vi.fn(),
    onTransferir: vi.fn(),
    onLimpar: vi.fn(),
  };
}

describe("BarraDeAcoesEmLote", () => {
  it("sem seleção, a barra não existe", () => {
    render(
      <BarraDeAcoesEmLote
        quantidade={0}
        pendente={false}
        {...mao()}
      />,
    );
    expect(screen.queryByTestId("barra-de-acoes-em-lote")).toBeNull();
  });

  it("com 3 selecionadas, a barra aparece e Fechar delega", async () => {
    const user = userEvent.setup();
    const h = mao();
    render(<BarraDeAcoesEmLote quantidade={3} pendente={false} {...h} />);

    expect(screen.getByTestId("barra-de-acoes-em-lote")).toBeInTheDocument();
    expect(screen.getByText("3 conversas selecionadas")).toBeInTheDocument();

    await user.click(screen.getByTestId("lote-fechar"));
    expect(h.onFechar).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId("lote-marcar-como-lida"));
    expect(h.onMarcarComoLida).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId("lote-limpar"));
    expect(h.onLimpar).toHaveBeenCalledTimes(1);
  });

  it("com 1 selecionada, o texto é singular", () => {
    render(<BarraDeAcoesEmLote quantidade={1} pendente={false} {...mao()} />);
    expect(screen.getByText("1 conversa selecionada")).toBeInTheDocument();
  });

  it("as ações secundárias saem do Mais ações e delegam", async () => {
    const user = userEvent.setup();
    const h = mao();
    render(<BarraDeAcoesEmLote quantidade={2} pendente={false} {...h} />);

    await user.click(screen.getByRole("button", { name: "Mais ações" }));
    await user.click(screen.getByTestId("lote-arquivar"));
    expect(h.onArquivar).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Mais ações" }));
    await user.click(screen.getByTestId("lote-pausar-ia"));
    expect(h.onPausarIa).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Mais ações" }));
    await user.click(screen.getByTestId("lote-devolver-ao-automatico"));
    expect(h.onDevolverAoAutomatico).toHaveBeenCalledTimes(1);
  });

  it("transferir em lote escolhe o destino e devolve (to_user_id, reason)", async () => {
    const user = userEvent.setup();
    const h = mao();
    render(<BarraDeAcoesEmLote quantidade={2} pendente={false} {...h} />);

    await user.click(screen.getByRole("button", { name: "Mais ações" }));
    await user.click(screen.getByTestId("lote-transferir"));

    // Sem destino, o confirmar fica desligado: transferir "para ninguém" não
    // é ação, é rodada de erro 422 depois.
    const confirmar = screen.getByTestId("lote-transferir-confirmar");
    expect(confirmar).toBeDisabled();

    // O gatilho do Select abre por teclado (Enter) — o caminho que funciona
    // sem PointerEvent, que o jsdom não implementa.
    const gatilho = screen.getByRole("combobox");
    gatilho.focus();
    fireEvent.keyDown(gatilho, { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "Bruno" }));
    expect(confirmar).toBeEnabled();

    await user.type(screen.getByLabelText("Motivo (opcional)"), "plantão");
    await user.click(confirmar);

    expect(h.onTransferir).toHaveBeenCalledWith(DESTINO, "plantão");
  });
});
