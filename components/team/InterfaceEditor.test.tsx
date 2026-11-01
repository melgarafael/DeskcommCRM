import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { INTERFACE_COMPLETA } from "@/lib/navigation/interface";

import { InterfaceEditor } from "./InterfaceEditor";

/**
 * O editor de Interface no celular (ADR-0006, F4): o seletor, o «Personalizar
 * áreas visíveis» e cada área marcável ganham 44px de alvo abaixo de `md`.
 * Contrato de classe (o jsdom não aplica media query); a altura medida não
 * existe em nenhuma spec.
 */
describe("InterfaceEditor: alvos de toque no celular", () => {
  it("seletor, resumo e cada área marcável têm 44px abaixo de md", () => {
    render(<InterfaceEditor value={INTERFACE_COMPLETA} onChange={vi.fn()} role="manager" />);
    expect(screen.getByLabelText("Perfil de interface")).toHaveClass("max-md:min-h-11");
    expect(screen.getByText("Personalizar áreas visíveis").closest("summary")).toHaveClass("max-md:py-3");
    const caixas = screen.getAllByRole("checkbox");
    expect(caixas.length).toBeGreaterThan(0);
    for (const caixa of caixas) {
      expect(caixa.closest("label")).toHaveClass("max-md:min-h-11", "max-md:items-center");
      // `mt-1` sem prefixo desalinhava a caixa do texto centrado no celular.
      expect(caixa.className.split(/\s+/)).toEqual(["md:mt-1"]);
    }
  });
});
