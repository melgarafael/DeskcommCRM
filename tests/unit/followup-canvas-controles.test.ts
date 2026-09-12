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
});
