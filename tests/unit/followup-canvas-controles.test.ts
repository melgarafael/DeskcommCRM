import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * OS BOTÕES DE ZOOM DO CANVAS SUMIAM NO TEMA ESCURO.
 *
 * O XYFlow pinta `.react-flow__controls-button` com fundo `#fefefe` e
 * `color: inherit`; o SVG usa `fill: currentColor`. No tema escuro o texto
 * da página é claro, então o ícone some no branco — um retângulo branco com
 * botões invisíveis no canto do canvas.
 *
 * O conserto é amarrar as vars `--xy-controls-button-*` (sem o sufixo
 * `-default`, que é o fallback da lib) aos tokens de superfície e texto.
 * Este teste lê o CSS, não geometria: a prova visual é o canvas aberto no
 * tema escuro. Aqui a rede é impedir a volta do fundo branco da lib.
 */

const CSS = readFileSync("app/globals.css", "utf8");

function bloco(seletor: string): string {
  const rx = new RegExp(`^${seletor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`, "m");
  const i = CSS.search(rx);
  if (i < 0) throw new Error(`não achei o bloco \`${seletor}\` em globals.css`);
  const fim = CSS.indexOf("\n}", i);
  if (fim < 0) throw new Error(`bloco \`${seletor}\` sem fechamento em globals.css`);
  return CSS.slice(i, fim);
}

describe("controles do canvas de follow-up seguem o tema", () => {
  it("pinta o botão com surface e o ícone com text, não com o branco da lib", () => {
    const corpo = bloco(".react-flow");
    expect(corpo).toMatch(
      /--xy-controls-button-background-color:\s*var\(--color-surface\)/,
    );
    expect(corpo).toMatch(/--xy-controls-button-color:\s*var\(--color-text\)/);
    expect(corpo).toMatch(
      /--xy-controls-button-border-color:\s*var\(--color-border\)/,
    );
  });

  it("não deixa o fundo do grupo de controles no branco da lib", () => {
    const corpo = bloco(".react-flow__controls");
    expect(corpo).toMatch(/background:\s*var\(--color-surface\)/);
    expect(corpo).toMatch(/border:\s*1px solid var\(--color-border\)/);
  });

  /**
   * A LINHA ENTRE DOIS PASSOS QUASE SUMIA NO TEMA CLARO. O cinza padrão da lib
   * (`#b1b1b7`) dá 2,03:1 sobre o fundo `#faf9f6` — abaixo dos 3:1 que a WCAG
   * 1.4.11 pede para elemento gráfico essencial, e a linha É o desenho do fluxo.
   * O contraste está medido no comentário do CSS; aqui a rede é o token, que
   * troca sozinho com o tema (o único que passa nos dois é `text-muted`).
   */
  it("a linha da aresta sai de um token, nunca do cinza padrão da lib", () => {
    const corpo = bloco(".react-flow");
    expect(corpo).toMatch(/--xy-edge-stroke:\s*var\(--color-text-muted\)/);
    expect(corpo).toMatch(/--xy-edge-stroke-selected:\s*var\(--color-accent\)/);
    // A linha que o usuário ARRASTA para criar a ligação lê outra var.
    expect(corpo).toMatch(/--xy-connectionline-stroke:\s*var\(--color-accent\)/);
    // Sem o sufixo `-default`: com ele, a var da lib venceria e nada mudaria.
    expect(corpo).not.toMatch(/--xy-edge-stroke-default/);
  });

  /**
   * ZOOM COM O DEDO. A folha da lib dá 26px ao botão com uma classe só e entra
   * DEPOIS deste arquivo na cascata (é importada pelo componente), então uma
   * regra de uma classe aqui perderia. O seletor de duas classes vence por
   * especificidade; a prova da caixa medida é `tests/e2e/ia-no-celular.spec.ts`.
   */
  it("com ponteiro grosso, o botão de zoom tem 44px e vence a folha da lib", () => {
    const i = CSS.indexOf("@media (pointer: coarse) {\n  .react-flow .react-flow__controls-button {");
    expect(i, "bloco de ponteiro grosso dos controles").toBeGreaterThan(-1);
    const corpo = CSS.slice(i, CSS.indexOf("\n}", i));
    expect(corpo).toMatch(/width:\s*44px/);
    expect(corpo).toMatch(/height:\s*44px/);
  });
});
