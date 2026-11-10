/**
 * A LUPA DO TOPO TEM NOME TAMBÉM NO CELULAR.
 *
 * Abaixo de `md` o botão mostra só o ícone, que é `aria-hidden`. Com o rótulo em
 * `hidden md:inline` (`display: none`), o leitor de tela anunciava um botão sem
 * nome. `max-md:sr-only` esconde o texto do olho e o mantém na árvore de
 * acessibilidade; no computador o rótulo segue à vista como antes.
 *
 * O jsdom não aplica as classes do Tailwind, então o nome acessível aqui sai do
 * texto de qualquer jeito: o que este caso segura é a CLASSE, que é o que decide
 * o nome no navegador de verdade.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/shell/CommandPalette", () => ({ CommandPalette: () => null }));

import { SearchTrigger } from "./SearchTrigger";

describe("lupa da busca no topo", () => {
  it("o rótulo fica na árvore de acessibilidade abaixo de md", () => {
    render(<SearchTrigger />);
    const botao = screen.getByRole("button", { name: /Buscar\.\.\./ });
    const rotulo = within(botao).getByText("Buscar...");
    const c = (rotulo.getAttribute("class") ?? "").split(/\s+/);
    expect(c).toContain("max-md:sr-only");
    // `hidden` é `display: none`: tira o texto da árvore e o botão fica sem nome.
    expect(c).not.toContain("hidden");
  });
});
