import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RenomearConexao } from "./RenomearConexao";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockReturnValue(
    Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchMock);
});

describe("RenomearConexao", () => {
  // #2892: depois de digitar outro nome e clicar Cancelar, o diálogo reabria
  // com o texto DESCARTADO (o `name` só era reposto quando `currentName`
  // mudava). Digitou 95 "X", cancelou, reabriu: o campo veio com 80 "X" — o
  // limite do maxLength — em vez do nome atual.
  it("depois de digitar e cancelar, reabrir mostra o nome atual, não o texto descartado", () => {
    render(
      <RenomearConexao channelId="c1" currentName="Atendimento" onSaved={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Renomear" }));
    const campo = screen.getByLabelText("Nome interno");
    expect(campo).toHaveValue("Atendimento");

    // O navegador corta no maxLength={80} — foi com esses 80 "X" que o
    // mantenedor viu o diálogo reabrir. O jsdom não aplica maxLength no
    // fireEvent.change, então o teste aplica o mesmo corte que a tela aplica.
    const digitado = "X".repeat(95).slice(0, 80);
    fireEvent.change(campo, { target: { value: digitado } });
    expect(campo).toHaveValue(digitado);

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    fireEvent.click(screen.getByRole("button", { name: "Renomear" }));
    expect(screen.getByLabelText("Nome interno")).toHaveValue("Atendimento");
  });

  it("fechar pelo X e reabrir também mostra o nome atual", () => {
    render(
      <RenomearConexao
        channelId="c1"
        currentName="WA | Fixo 7906"
        onSaved={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Renomear" }));
    fireEvent.change(screen.getByLabelText("Nome interno"), {
      target: { value: "X".repeat(95) },
    });

    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));

    fireEvent.click(screen.getByRole("button", { name: "Renomear" }));
    expect(screen.getByLabelText("Nome interno")).toHaveValue("WA | Fixo 7906");
  });

  it("quando a lista repõe o nome atual com o diálogo fechado, reabrir mostra o nome novo", () => {
    const { rerender } = render(
      <RenomearConexao channelId="c1" currentName="Atendimento" onSaved={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Renomear" }));
    fireEvent.change(screen.getByLabelText("Nome interno"), {
      target: { value: "X".repeat(95) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    rerender(
      <RenomearConexao channelId="c1" currentName="WA | Fixo 7906" onSaved={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Renomear" }));
    expect(screen.getByLabelText("Nome interno")).toHaveValue("WA | Fixo 7906");
  });

  it("salvar envia o nome digitado e fecha o diálogo", async () => {
    const onSaved = vi.fn();
    render(
      <RenomearConexao channelId="c1" currentName="Atendimento" onSaved={onSaved} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Renomear" }));
    fireEvent.change(screen.getByLabelText("Nome interno"), {
      target: { value: "WA | Fixo 7906" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const chamada = fetchMock.mock.calls.at(-1);
    expect((chamada?.[1] as RequestInit).method).toBe("PATCH");
    expect(JSON.parse(String((chamada?.[1] as RequestInit).body))).toEqual({
      display_name: "WA | Fixo 7906",
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Cancelar" })).not.toBeInTheDocument(),
    );
  });
});
