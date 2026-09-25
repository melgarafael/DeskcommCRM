import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AtendimentoForm, type AtendimentoConfig } from "./_form";

/**
 * A DEVOLUÇÃO AUTOMÁTICA TEM SUPERFÍCIE — e a superfície manda o que diz.
 *
 * O knob `handoff_return_after_minutes` nasceu com tela (invariante "toda
 * configuração tem superfície"). O que se prova aqui: desligado, o corpo do
 * PATCH leva `null` (a IA-06 de sempre); ligado, leva os minutos digitados — e
 * o campo de minutos só aparece quando está ligado.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetcher = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  fetcher.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
});

const inicial: AtendimentoConfig = {
  mode: "manual",
  max_retries: 5,
  backoff_seconds: 60,
  visibility_mode: "all",
  handoff_return_after_minutes: null,
  conversation_stays_with_attendant: false,
};

function corpoDoPatch(): Record<string, unknown> {
  const chamada = fetcher.mock.calls[0];
  expect(chamada, "o PATCH não saiu").toBeDefined();
  return JSON.parse((chamada![1] as { body: string }).body) as Record<string, unknown>;
}

describe("Distribuição de atendimento — devolver ao agente sozinho", () => {
  it("desligado por padrão: sem campo de minutos, e o corpo salvo leva null", async () => {
    render(<AtendimentoForm initial={{ ...inicial, mode: "round_robin" }} />);
    expect(screen.getByTestId("devolver-sozinho")).not.toBeChecked();
    expect(screen.queryByLabelText("Minutos sem resposta da equipe")).not.toBeInTheDocument();

    // Mexe em outra coisa só para o Salvar destravar.
    fireEvent.click(screen.getByTestId("opcao-modo-manual"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(corpoDoPatch()).toMatchObject({ mode: "manual", handoff_return_after_minutes: null });
  });

  it("ligar sugere 60 min, aceita outro valor e o corpo salvo leva os minutos", async () => {
    render(<AtendimentoForm initial={inicial} />);
    fireEvent.click(screen.getByTestId("devolver-sozinho"));

    const minutos = screen.getByLabelText("Minutos sem resposta da equipe");
    expect(minutos).toHaveValue(60);
    fireEvent.change(minutos, { target: { value: "45" } });

    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(corpoDoPatch()).toMatchObject({ handoff_return_after_minutes: 45 });
  });

  it("desligar de novo volta a null — não guarda o número escondido", async () => {
    render(<AtendimentoForm initial={{ ...inicial, handoff_return_after_minutes: 90 }} />);
    expect(screen.getByLabelText("Minutos sem resposta da equipe")).toHaveValue(90);
    fireEvent.click(screen.getByTestId("devolver-sozinho"));
    expect(screen.queryByLabelText("Minutos sem resposta da equipe")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(corpoDoPatch()).toMatchObject({ handoff_return_after_minutes: null });
  });
});

describe("Distribuição de atendimento — a conversa fica com quem atendeu", () => {
  it("desligado por padrão, e salvar outra coisa manda false", async () => {
    render(<AtendimentoForm initial={inicial} />);
    expect(screen.getByTestId("fica-com-quem-atendeu")).not.toBeChecked();
    fireEvent.click(screen.getByTestId("opcao-modo-round_robin"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(corpoDoPatch()).toMatchObject({ conversation_stays_with_attendant: false });
  });

  it("ligar manda true", async () => {
    render(<AtendimentoForm initial={inicial} />);
    fireEvent.click(screen.getByTestId("fica-com-quem-atendeu"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(corpoDoPatch()).toMatchObject({ conversation_stays_with_attendant: true });
  });

  it("empresa com o ajuste ligado vê a caixa marcada", () => {
    render(<AtendimentoForm initial={{ ...inicial, conversation_stays_with_attendant: true }} />);
    expect(screen.getByTestId("fica-com-quem-atendeu")).toBeChecked();
  });
});
