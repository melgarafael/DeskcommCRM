/**
 * A barra lateral gruda — e quem a quebra não é ela.
 *
 * `components/shell/Sidebar.tsx` é `sticky top-0 h-screen`, com um comentário
 * longo explicando por que NÃO é `fixed` (duas medidas para a mesma coisa, e a
 * barra passando por cima da lista no dia em que discordaram). Mesmo assim ela
 * rolava com a página: sumia do alto e deixava faixa vazia embaixo.
 *
 * A causa estava três arquivos adiante. `overflow-x: hidden` no `<html>` e no
 * `<body>` — a rede contra scroll horizontal da página — faz o elemento virar
 * CONTÊINER DE ROLAGEM, e contêiner de rolagem no ancestral desliga
 * `position: sticky` lá dentro. Duas proteções corretas que se anulavam.
 *
 * `overflow-x: clip` corta igual sem criar contêiner de rolagem. O `hidden`
 * fica antes como reserva para motor sem `clip`.
 *
 * ⚠️ ESTE TESTE É UMA CERCA, NÃO UMA PROVA. Ele garante que a declaração não
 * volte a ser só `hidden` — o modo pelo qual o defeito voltaria, e voltaria em
 * silêncio, porque nada na tela diz "o sticky morreu". O que ele NÃO faz é
 * medir a barra num navegador; isso é trabalho de Playwright com
 * `getBoundingClientRect`, e está anotado como pendência no PR.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(__dirname, "..", "..", "app", "globals.css"), "utf8");

/** O bloco de uma regra de topo (`html {` / `body {`) dentro de `@layer base`. */
function blocoDe(seletor: string): string {
  const i = CSS.indexOf(`\n  ${seletor} {`);
  expect(i, `não achei a regra \`${seletor}\` em globals.css`).toBeGreaterThan(-1);
  const fim = CSS.indexOf("\n  }", i);
  return CSS.slice(i, fim);
}

describe("a rede contra scroll horizontal não pode matar o sticky", () => {
  for (const seletor of ["html", "body"]) {
    describe(`<${seletor}>`, () => {
      const bloco = blocoDe(seletor);

      it("ainda barra o scroll horizontal da página", () => {
        expect(bloco).toMatch(/overflow-x:\s*(hidden|clip)\s*;/);
      });

      it("declara `clip`, que não cria contêiner de rolagem", () => {
        expect(bloco).toMatch(/overflow-x:\s*clip\s*;/);
      });

      it("mantém `hidden` ANTES, como reserva para motor sem `clip`", () => {
        const posHidden = bloco.search(/overflow-x:\s*hidden\s*;/);
        const posClip = bloco.search(/overflow-x:\s*clip\s*;/);
        expect(posHidden).toBeGreaterThan(-1);
        expect(posClip).toBeGreaterThan(posHidden);
      });
    });
  }

  it("a barra lateral continua `sticky`, e nunca `fixed`", () => {
    // O outro lado do par. Se alguém trocar por `fixed` para "resolver", volta o
    // defeito que o comentário do Sidebar registra: barra por cima da lista.
    const sidebar = readFileSync(
      join(__dirname, "..", "..", "components", "shell", "Sidebar.tsx"),
      "utf8",
    );
    expect(sidebar).toContain("sticky top-0");
    expect(sidebar).not.toMatch(/className=\{?[^}]*"fixed /);
  });
});
