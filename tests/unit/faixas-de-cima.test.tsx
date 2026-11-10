import { readFileSync } from "node:fs";

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FaixasDeCima, VARIAVEL_DAS_FAIXAS } from "@/components/shell/FaixasDeCima";

/**
 * AS FAIXAS DE CIMA PUBLICAM A PRÓPRIA ALTURA (F2 da ADR-0006).
 *
 * O aviso de WhatsApp desconectado quebra em uma, duas ou três linhas conforme
 * o papel e a largura, então nenhuma constante descreve a altura dele. Quem
 * precisa descontá-la (a casca, a grade do Inbox, a conversa em tela cheia)
 * lê `--faixas-de-cima`, e este arquivo prende quem a escreve.
 */

let altura = 0;
let avisar: (() => void) | null = null;

class ResizeObserverFalso {
  constructor(cb: () => void) {
    avisar = cb;
  }
  observe() {}
  disconnect() {
    avisar = null;
  }
}

beforeEach(() => {
  altura = 0;
  avisar = null;
  vi.stubGlobal("ResizeObserver", ResizeObserverFalso);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ height: altura, width: 390, top: 0, left: 0, right: 390, bottom: altura, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty(VARIAVEL_DAS_FAIXAS);
});

const lida = () => document.documentElement.style.getPropertyValue(VARIAVEL_DAS_FAIXAS);

describe("FaixasDeCima", () => {
  it("publica a altura medida no <html>", () => {
    altura = 48;
    render(<FaixasDeCima><div>faixa</div></FaixasDeCima>);
    expect(lida()).toBe("48px");
  });

  it("atualiza quando a faixa muda de altura (quebra de linha, faixa nova)", () => {
    altura = 48;
    render(<FaixasDeCima><div>faixa</div></FaixasDeCima>);
    altura = 92;
    act(() => avisar?.());
    expect(lida()).toBe("92px");
  });

  it("desmontar remove a variável — ninguém desconta faixa que não existe", () => {
    altura = 48;
    const { unmount } = render(<FaixasDeCima><div>faixa</div></FaixasDeCima>);
    unmount();
    expect(lida()).toBe("");
  });

  it("o invólucro é quem gruda no topo: num <div> comum as faixas rolariam junto", () => {
    // Um `sticky` só gruda dentro da caixa do PAI. Com as faixas dentro de um
    // invólucro da mesma altura que elas, o sticky de cada uma deixa de valer —
    // o aviso de canal caído sumiria ao rolar qualquer tela.
    const { container } = render(<FaixasDeCima><div>faixa</div></FaixasDeCima>);
    const involucro = container.firstElementChild as HTMLElement;
    expect(involucro.className).toMatch(/\bsticky\b/);
    expect(involucro.className).toMatch(/\btop-0\b/);
  });
});

describe("quem desconta as faixas", () => {
  it("a casca e a grade do Inbox leem a variável", () => {
    const casca = readFileSync("app/app/_components/AppShell.tsx", "utf8");
    const inbox = readFileSync("components/inbox/InboxLayout.tsx", "utf8");
    // As DUAS caixas da casca: a de fora e a coluna do conteúdo.
    expect(casca.split("min-h-[calc(100dvh-var(--faixas-de-cima,0px))]").length - 1).toBe(2);
    expect(inbox).toMatch(/h-\[calc\(100dvh-var\(--faixas-de-cima,0px\)-3\.5rem/);
  });

  it("a barra de cima e a lateral grudam ABAIXO das faixas, sem passar por baixo delas", () => {
    // As faixas são `sticky top-0 z-50`. Com o TopBar e a Sidebar também em
    // `top-0`, rolar uma tela longa deixava a faixa por cima da busca, do sino
    // e do topo da barra lateral. E a Sidebar com `h-dvh` cheio fazia o
    // documento medir tela + faixa no computador.
    const topo = readFileSync("components/shell/TopBar.tsx", "utf8");
    const lateral = readFileSync("components/shell/Sidebar.tsx", "utf8");
    expect(topo).toMatch(/<header className="sticky top-\[var\(--faixas-de-cima,0px\)\] /);
    expect(lateral).toMatch(
      /"sticky top-\[var\(--faixas-de-cima,0px\)\] z-30 flex h-\[calc\(100dvh-var\(--faixas-de-cima,0px\)\)\] /,
    );
  });

  it("o layout do /app envolve as faixas com ele", () => {
    const layout = readFileSync("app/app/layout.tsx", "utf8");
    expect(layout).toMatch(/<FaixasDeCima>\s*<ImpersonateBanner[\s\S]*?<\/FaixasDeCima>/);
  });
});
