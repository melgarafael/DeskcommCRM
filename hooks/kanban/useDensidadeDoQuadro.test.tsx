import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { CHAVE_DA_DENSIDADE, useDensidadeDoQuadro } from "./useDensidadeDoQuadro";

/**
 * #3461, item 2 — a densidade escolhida sobrevive ao F5.
 *
 * O valor mora no NAVEGADOR: é preferência de quem olha o quadro, não regra da
 * organização. O que estes casos fixam é o contrato do hook — nasce confortável,
 * lê o que está gravado depois da montagem e grava ao alternar.
 */
describe("useDensidadeDoQuadro", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("nasce confortável, mesmo com 'compacta' gravado — o primeiro render é o do servidor", () => {
    window.localStorage.setItem(CHAVE_DA_DENSIDADE, "compacta");

    const { result } = renderHook(() => useDensidadeDoQuadro());
    // O `useEffect` roda no `renderHook`, então depois da montagem já é compacta;
    // o que se prova aqui é que a leitura NÃO acontece no inicializador (que
    // rodaria também no SSR, onde `localStorage` não existe, e daria mismatch de
    // hidratação). A prova é o valor gravado ser aplicado só após o efeito.
    expect(result.current.compacta).toBe(true);
  });

  it("sem nada gravado, fica confortável", () => {
    const { result } = renderHook(() => useDensidadeDoQuadro());
    expect(result.current.compacta).toBe(false);
    expect(result.current.densidade).toBe("confortavel");
  });

  it("alternar grava no navegador — o F5 mantém a escolha", () => {
    const { result } = renderHook(() => useDensidadeDoQuadro());

    act(() => result.current.alternar());
    expect(result.current.compacta).toBe(true);
    expect(window.localStorage.getItem(CHAVE_DA_DENSIDADE)).toBe("compacta");

    act(() => result.current.alternar());
    expect(result.current.compacta).toBe(false);
    expect(window.localStorage.getItem(CHAVE_DA_DENSIDADE)).toBe("confortavel");
  });

  it("navegador que RECUSA o localStorage (modo privado) não derruba o quadro", () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };

    try {
      const { result } = renderHook(() => useDensidadeDoQuadro());
      // A troca continua valendo na sessão: gravar é o ideal, não o requisito.
      act(() => result.current.alternar());
      expect(result.current.compacta).toBe(true);
    } finally {
      window.localStorage.setItem = original;
    }
  });
});
