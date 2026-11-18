/**
 * O painel da espera: o horário (`ate_o_horario`) liga, edita e desliga — e o
 * que o painel NÃO mostra ele não apaga.
 *
 * O defeito que o segundo bloco prende: `commit` remontava a config só com os
 * campos da tela. Mudar a duração de uma espera imune (`immune_to_reply`, que
 * chega por importação ou modelo e não tem controle aqui) gravava uma espera
 * comum, e a cadência longa passava a ser cortada pela primeira resposta.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConfigOf } from "./shared";
import { WaitForm } from "./WaitForm";

const H = 3_600_000;
/** Um horário que já vinha no nó, diferente do padrão da chave — dado sintético. */
const COMERCIAL = { start: "07:30", end: "17:00", weekdays: [1, 2, 3, 4, 5, 6] };

const horarioDe = (c: ConfigOf<"wait">) => (c.mode === "fixed" ? c.ate_o_horario : undefined);

function montar(config: ConfigOf<"wait">) {
  const onChange = vi.fn();
  render(<WaitForm config={config} onChange={onChange} />);
  return { onChange, ultima: () => onChange.mock.calls.at(-1)?.[0] as ConfigOf<"wait"> };
}

describe("WaitForm — horário da espera", () => {
  it("ligar o horário grava o padrão de dias úteis; desligar tira a chave", () => {
    const { ultima } = montar({ mode: "fixed", duration_ms: 24 * H });
    const chave = screen.getByRole("switch", { name: "Só terminar a espera em horário comercial" });

    fireEvent.click(chave);
    expect(ultima()).toEqual({
      mode: "fixed",
      duration_ms: 24 * H,
      ate_o_horario: { start: "09:00", end: "18:00", weekdays: [1, 2, 3, 4, 5] },
    });

    fireEvent.click(chave);
    expect(ultima()).toEqual({ mode: "fixed", duration_ms: 24 * H });
  });

  it("edita horas e dias do horário que já vinha no nó", () => {
    const { ultima } = montar({ mode: "fixed", duration_ms: 24 * H, ate_o_horario: COMERCIAL });

    fireEvent.change(screen.getByLabelText("Fim"), { target: { value: "16:00" } });
    expect(horarioDe(ultima())).toEqual({ ...COMERCIAL, end: "16:00" });

    // Sábado (6) sai; os outros dias ficam.
    fireEvent.click(screen.getByRole("button", { name: "Sáb" }));
    expect(horarioDe(ultima())).toEqual({ start: "07:30", end: "16:00", weekdays: [1, 2, 3, 4, 5] });
  });
});

describe("WaitForm — o que o painel não edita, ele conserva", () => {
  it("mudar a duração mantém o horário e a imunidade", () => {
    const { ultima } = montar({ mode: "fixed", duration_ms: 24 * H, immune_to_reply: true, ate_o_horario: COMERCIAL });

    fireEvent.change(screen.getByLabelText("Duração (minutos)"), { target: { value: "2880" } });

    expect(ultima()).toEqual({ mode: "fixed", duration_ms: 48 * H, immune_to_reply: true, ate_o_horario: COMERCIAL });
  });
});
