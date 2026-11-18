/**
 * O "Vale até" de um aprendizado grava ao SAIR do campo, não a cada tecla (#3537).
 *
 * Prova de tela de 31/10: com o campo gravando no `onChange`, o primeiro dígito do
 * ano já emitia "0002-11-15" — o navegador entrega um valor completo a cada
 * segmento —, o PATCH saía, o aprendizado nascia vencido e o foco se perdia no
 * meio da digitação. E o selo mostrava 1902, porque `new Date(2, …)` lê o ano 2
 * como 1902.
 */
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ValidadeDaLinha, formatDateOnly } from "@/app/app/ai/memory/_client";

function montar(valor: string) {
  const onSalvar = vi.fn();
  render(
    <>
      <label htmlFor="v">Vale até</label>
      <ValidadeDaLinha id="v" valor={valor} onSalvar={onSalvar} />
    </>,
  );
  return { onSalvar, campo: screen.getByLabelText("Vale até") as HTMLInputElement };
}

describe("ValidadeDaLinha", () => {
  it("digitar não grava; sair do campo grava UMA vez o valor final", () => {
    const { onSalvar, campo } = montar("");
    fireEvent.change(campo, { target: { value: "0002-11-15" } });
    fireEvent.change(campo, { target: { value: "0020-11-15" } });
    fireEvent.change(campo, { target: { value: "2026-11-15" } });
    expect(onSalvar).not.toHaveBeenCalled();
    fireEvent.blur(campo);
    expect(onSalvar).toHaveBeenCalledTimes(1);
    expect(onSalvar).toHaveBeenCalledWith("2026-11-15");
  });

  it("sair sem mudar não grava", () => {
    const { onSalvar, campo } = montar("2026-11-01");
    fireEvent.blur(campo);
    expect(onSalvar).not.toHaveBeenCalled();
  });

  it("apagar a data e sair grava vazio (volta a 'sem prazo')", () => {
    const { onSalvar, campo } = montar("2026-11-01");
    fireEvent.change(campo, { target: { value: "" } });
    fireEvent.blur(campo);
    expect(onSalvar).toHaveBeenCalledWith("");
  });
});

describe("formatDateOnly", () => {
  it("ano abaixo de 100 não vira 19xx", () => {
    expect(formatDateOnly("0002-11-15", "pt-BR")).not.toContain("1902");
    expect(formatDateOnly("0002-11-15", "pt-BR")).toBe("15/11/2");
  });

  it("dia do calendário, sem fuso no meio", () => {
    expect(formatDateOnly("2026-10-26", "pt-BR")).toBe("26/10/2026");
  });
});
