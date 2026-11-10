import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAlturaVisivel } from "./altura-visivel";

/**
 * O TECLADO DO CELULAR, MEDIDO PELO `visualViewport`.
 *
 * A régua é a MAIOR altura já vista, não `innerHeight`: no Android com
 * `interactive-widget=resizes-content` o `innerHeight` encolhe junto com o
 * teclado, e no iOS ele não muda. Comparar com o maior valor visto vale nos dois.
 */

class ViewportFalso extends EventTarget {
  height = 844;
  width = 390;
  offsetTop = 0;
  scale = 1;
  mudar(parcial: Partial<Pick<ViewportFalso, "height" | "width" | "offsetTop" | "scale">>) {
    Object.assign(this, parcial);
    this.dispatchEvent(new Event("resize"));
  }
}

let vv: ViewportFalso;
let grosso = true;
/** A largura do layout (`documentElement.clientWidth`): só muda quando o aparelho gira. */
let larguraDoLayout = 390;

beforeEach(() => {
  vv = new ViewportFalso();
  grosso = true;
  larguraDoLayout = 390;
  vi.spyOn(document.documentElement, "clientWidth", "get").mockImplementation(() => larguraDoLayout);
  vi.stubGlobal("visualViewport", vv);
  vi.stubGlobal(
    "matchMedia",
    (q: string) => ({ matches: q === "(pointer: coarse)" && grosso, media: q }) as MediaQueryList,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function montar(ativo = true) {
  const el = document.createElement("div");
  const ref = { current: el };
  const hook = renderHook(({ a }) => useAlturaVisivel(ref, a), { initialProps: { a: ativo } });
  return { el, hook };
}

describe("useAlturaVisivel", () => {
  it("844 → 500 é teclado aberto; voltar a 844 fecha", () => {
    const { el, hook } = montar();
    expect(hook.result.current).toBe(false);
    expect(el.style.getPropertyValue("--vv-altura")).toBe("844px");

    act(() => vv.mudar({ height: 500, offsetTop: 120 }));
    expect(hook.result.current).toBe(true);
    expect(el.style.getPropertyValue("--vv-altura")).toBe("500px");
    expect(el.style.getPropertyValue("--vv-topo")).toBe("120px");

    act(() => vv.mudar({ height: 844, offsetTop: 0 }));
    expect(hook.result.current).toBe(false);
  });

  it("girar o aparelho zera a maior altura — paisagem não conta como teclado", () => {
    const { hook } = montar();
    larguraDoLayout = 844;
    act(() => vv.mudar({ width: 844, height: 390 }));
    expect(hook.result.current).toBe(false);
  });

  // O ZOOM DO SAFARI. Ampliada, a área visível encolhe em px de CSS nas DUAS
  // direções (largura e altura divididas pela escala) sem o layout mudar. A
  // régua compara em px de TELA (`height * scale`) e só zera quando a largura
  // do LAYOUT muda — não a do `visualViewport`, que o zoom também muda.
  it("zoom de 1,15 sem teclado não é teclado", () => {
    const { hook } = montar();
    act(() => vv.mudar({ scale: 1.15, width: 390 / 1.15, height: 844 / 1.15 }));
    expect(hook.result.current).toBe(false);
  });

  it("zoom de 1,5 (pinça) sem teclado não é teclado: a altura em px de CSS cai a 563, mas na tela segue 844", () => {
    const { hook } = montar();
    act(() => vv.mudar({ scale: 1.5, width: 390 / 1.5, height: 844 / 1.5 }));
    expect(hook.result.current).toBe(false);
  });

  it("zoom de 1,15 COM teclado é teclado aberto (o foco num campo de 14px no iPhone)", () => {
    const { hook } = montar();
    act(() => vv.mudar({ scale: 1.15, width: 390 / 1.15, height: 500 / 1.15, offsetTop: 120 }));
    expect(hook.result.current).toBe(true);
  });

  it("encolher pouco (barra do navegador recolhendo) não é teclado", () => {
    const { hook } = montar();
    act(() => vv.mudar({ height: 760 }));
    expect(hook.result.current).toBe(false);
  });

  it("inativo não escuta nem escreve nada", () => {
    const espiao = vi.spyOn(vv, "addEventListener");
    const { el, hook } = montar(false);
    expect(espiao).not.toHaveBeenCalled();
    expect(el.style.getPropertyValue("--vv-altura")).toBe("");
    expect(hook.result.current).toBe(false);
  });

  it("ponteiro fino (computador) não liga: encolher a janela não é teclado", () => {
    grosso = false;
    const { el, hook } = montar();
    act(() => vv.mudar({ height: 400 }));
    expect(hook.result.current).toBe(false);
    expect(el.style.getPropertyValue("--vv-altura")).toBe("");
  });

  it("desligar limpa as variáveis e devolve fechado", () => {
    const { el, hook } = montar();
    act(() => vv.mudar({ height: 500 }));
    expect(hook.result.current).toBe(true);
    hook.rerender({ a: false });
    expect(hook.result.current).toBe(false);
    expect(el.style.getPropertyValue("--vv-altura")).toBe("");
    expect(el.style.getPropertyValue("--vv-topo")).toBe("");
  });

  it("sem visualViewport (navegador antigo) fica fechado e sem variáveis — vale o 100dvh", () => {
    vi.stubGlobal("visualViewport", undefined);
    const { el, hook } = montar();
    expect(hook.result.current).toBe(false);
    expect(el.style.getPropertyValue("--vv-altura")).toBe("");
  });
});
